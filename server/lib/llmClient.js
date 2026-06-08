/**
 * CDST — LLM Client
 * ==================
 * Shared Gemini client instance imported by all stage files.
 * API key is read from the GEMINI_API_KEY environment variable.
 *
 * Direct port of llm_client.py
 */

import { GoogleGenAI } from '@google/genai';

const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const CASCADE_STATUSES = new Set([503, 404, 429]);

// ---------------------------------------------------------------------------
// Pricing (USD per 1M tokens, May 2026)
// ---------------------------------------------------------------------------

const PRICING = {
  'gemini-3.5-flash':      { input: 0.15, output: 0.60 },
  'gemini-3.1-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-2.5-flash':      { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-2.5-pro':        { input: 1.25, output: 10.00 },
};

/**
 * Calculate cost in USD for a given model + token counts.
 */
export function calculateCost(model, inputTokens, outputTokens) {
  const p = PRICING[model];
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Usage log (backward compat)
// ---------------------------------------------------------------------------

const _usageLog = [];

/**
 * Drain and return all usage entries accumulated since the last call.
 */
export function popUsageLog() {
  const entries = [..._usageLog];
  _usageLog.length = 0;
  return entries;
}

/**
 * Extract full text from a Gemini response, concatenating all parts.
 */
export function responseText(response) {
  try {
    const parts = response.candidates[0].content.parts;
    return parts
      .filter(p => p.text)
      .map(p => p.text)
      .join('');
  } catch {
    return response.text || '';
  }
}

/**
 * Parse JSON from a Gemini response, tolerating markdown code fences.
 */
export function parseJsonResponse(text) {
  let t = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences
  t = t.replace(/^```(?:json)?\s*/, '');
  t = t.replace(/\s*```$/, '');
  t = t.trim();

  try {
    return JSON.parse(t);
  } catch {
    // noop
  }

  // Last resort: find first { or [
  for (const ch of ['{', '[']) {
    const idx = t.indexOf(ch);
    if (idx !== -1) {
      try {
        return JSON.parse(t.slice(idx));
      } catch {
        // noop
      }
    }
  }

  console.log(`\nDEBUG raw response.text (${text.length} chars):\n${text.slice(0, 1000)}\n`);
  throw new Error('Cannot parse JSON from Gemini response — see DEBUG above');
}

/**
 * Build multimodal content (text + inline images) for Gemini.
 * If photos is empty/null, returns just the text string (backward compatible).
 * @param {string} prompt - The text prompt
 * @param {Array} photos - Array of { mimeType, data } base64 photo objects (optional)
 * @returns {string|Array} - Plain string or Gemini Content array
 */
export function buildMultimodalContent(prompt, photos) {
  if (!photos || photos.length === 0) return prompt;
  const parts = [];
  // Add photos first so Gemini sees them before the text instructions
  for (const photo of photos) {
    parts.push({ inlineData: { mimeType: photo.mimeType, data: photo.data } });
  }
  parts.push({ text: `The nurse has attached ${photos.length} clinical photo(s) above. Incorporate visual findings from these images into your analysis.\n\n${prompt}` });
  return [{ role: 'user', parts }];
}

/**
 * Build content array with inline audio segments for Gemini.
 * Passes each 12-second m4a segment as a separate inlineData part — Gemini processes
 * them as a continuous recording. Falls back to buildMultimodalContent if no audio.
 * @param {string} prompt - The text prompt
 * @param {Buffer[]} audioBuffers - Array of m4a Buffer objects (one per segment)
 * @param {string} mimeType - Audio MIME type, default 'audio/mp4'
 * @param {Array} photos - Array of { mimeType, data } base64 photo objects (optional)
 * @returns {string|Array} - Plain string or Gemini Content array
 */
export function buildAudioContent(prompt, audioBuffers, mimeType = 'audio/mp4', photos = []) {
  if (!audioBuffers || audioBuffers.length === 0) {
    return buildMultimodalContent(prompt, photos);
  }
  const parts = [];
  for (const buf of audioBuffers) {
    parts.push({ inlineData: { mimeType, data: buf.toString('base64') } });
  }
  for (const photo of (photos || [])) {
    parts.push({ inlineData: { mimeType: photo.mimeType, data: photo.data } });
  }
  const photoNote = photos && photos.length > 0
    ? `The nurse has also attached ${photos.length} clinical photo(s). Incorporate visual findings from these images into your analysis.\n\n`
    : '';
  parts.push({ text: `${photoNote}${prompt}` });
  return [{ role: 'user', parts }];
}

/**
 * Try each model in order; cascade to the next on 503/404/429.
 * Returns { response, meta } where meta = { model_used, input_tokens, output_tokens, cost_usd }.
 */
export async function generateWithCascade(models, contents, config = {}) {
  let lastErr = null;
  for (const model of models) {
    try {
      // Strip thinkingConfig for models that don't support it
      let modelConfig = { ...config };
      if (!model.includes('2.5') && !model.includes('3-flash') && !model.includes('3.') && modelConfig.thinkingConfig) {
        delete modelConfig.thinkingConfig;
      }

      // Default to low temperature for deterministic, factual clinical output
      if (modelConfig.temperature == null) {
        modelConfig.temperature = 0.2;
      }

      // Default system instruction: clinical safety
      if (!modelConfig.systemInstruction) {
        modelConfig.systemInstruction = 'You are a clinical decision support system. Extract and report only what is explicitly present in the provided data. Do not infer, assume, or fabricate information. If the input data is insufficient, state that clearly rather than guessing.';
      }

      const response = await gemini.models.generateContent({
        model,
        contents,
        config: modelConfig,
      });
      const u = response.usageMetadata;
      const inputTokens = u?.promptTokenCount || 0;
      const outputTokens = u?.candidatesTokenCount || 0;
      const meta = {
        model_used: model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: calculateCost(model, inputTokens, outputTokens),
      };

      _usageLog.push({ model, input_tokens: inputTokens, output_tokens: outputTokens });

      if (model !== models[0]) {
        console.warn(`[LLM] Cascade: used ${model} (primary ${models[0]} unavailable)`);
      }
      return { response, meta };
    } catch (err) {
      const code = err.status || err.code || 0;
      const msg = (err.message || '').toLowerCase();
      const shouldCascade = CASCADE_STATUSES.has(code) || msg.includes('503') || msg.includes('429') || msg.includes('unavailable') || msg.includes('overloaded') || msg.includes('resource_exhausted') || msg.includes('no longer available') || msg.includes('not found');
      if (!shouldCascade) throw err;
      lastErr = err;
      console.warn(`[LLM] Gemini ${code || 'error'} on ${model} — cascading to next model`);
    }
  }
  throw lastErr;
}

export { gemini };
