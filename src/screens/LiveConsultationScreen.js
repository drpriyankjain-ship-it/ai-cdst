/**
 * Live Consultation Screen
 * ==========================
 * Real-time 3-phase clinical consultation with WebSocket.
 * Replaces the old RecordPage.
 */

import React, {useState, useCallback, useRef, useEffect} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, SafeAreaView,
  Alert, TextInput, ScrollView, ActivityIndicator, Vibration, Platform,
} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Audio} from 'expo-av';
import wsService from '../services/wsService';
import {
  PhaseIndicator, StreamingText, QuestionnaireCard,
  DifferentialCard, ClarifyingCard, PrescriptionCard, TriageCard,
} from '../components/LiveConsultationComponents';

const AUTH_TOKEN_KEY = '@nurseai_auth_token';
const API_BASE = process.env.EXPO_PUBLIC_API_URL || (__DEV__ ? 'http://172.20.10.2:3000' : 'https://v2.nurseai.in');

const PHASE_LABELS = {
  1: {title: 'Phase 1: Opening', instruction: 'Ask patient name, age, village, and chief complaint (~30 seconds)', marker: 'history_complete', next: 'Finish Opening →'},
  2: {title: 'Phase 2: Interview', instruction: 'Read the questionnaire to the patient and record their answers', marker: 'diagnosis_complete', next: 'Finish Interview →'},
  3: {title: 'Phase 3: Assessment', instruction: 'Ask clarifying questions and perform bedside observations', marker: 'management_complete', next: 'Finish Assessment →'},
};

const LiveConsultationScreen = ({navigation}) => {
  // Session state
  const [sessionState, setSessionState] = useState('idle'); // idle | connecting | active | complete
  const [patientName, setPatientName] = useState('');
  const [patientId, setPatientId] = useState('');
  const [currentPhase, setCurrentPhase] = useState(1);
  const [connectionState, setConnectionState] = useState('disconnected');
  const [sessionId, setSessionId] = useState(null);

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recordingRef = useRef(null);
  const recordingIntervalRef = useRef(null);
  const sessionStartRef = useRef(null);

  // AI output state
  const [streamingText, setStreamingText] = useState('');
  const [streamingLabel, setStreamingLabel] = useState('');
  const [questionnaire, setQuestionnaire] = useState(null);
  const [differential, setDifferential] = useState(null);
  const [clarifyingQs, setClarifyingQs] = useState(null);
  const [problemList, setProblemList] = useState(null);
  const [triageOutput, setTriageOutput] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Live transcript
  const [liveTranscript, setLiveTranscript] = useState('');

  const scrollRef = useRef(null);

  // Auto-scroll when new content arrives
  useEffect(() => {
    if (streamingText || questionnaire || differential || problemList || triageOutput) {
      setTimeout(() => scrollRef.current?.scrollToEnd({animated: true}), 200);
    }
  }, [streamingText, questionnaire, differential, problemList, triageOutput]);

  // ---------------------------------------------------------------------------
  // WebSocket event handlers
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const unsubs = [
      wsService.on('connection_state', ({state}) => setConnectionState(state)),

      wsService.on('session_ready', (msg) => {
        setSessionId(msg.session_id);
        setSessionState('active');
        setCurrentPhase(1);
        sessionStartRef.current = Date.now();
        startRecording();
      }),

      wsService.on('stage_token', ({stage, token}) => {
        setIsProcessing(true);
        setStreamingLabel(stage === 'history' ? 'Generating Questionnaire...' : stage === 'diagnosis' ? 'Analyzing Differential...' : 'Building Management Plan...');
        setStreamingText(prev => prev + token);
      }),

      wsService.on('stage_complete', ({stage, data}) => {
        setIsProcessing(false);
        setStreamingText('');
        setStreamingLabel('');

        if (stage === 'history') {
          setQuestionnaire(data);
          setCurrentPhase(2);
          Vibration.vibrate(200);
        } else if (stage === 'diagnosis') {
          setDifferential(data.differential || data.ddx);
          setClarifyingQs(data.clarifying_questions || data.clarifying);
          setCurrentPhase(3);
          Vibration.vibrate(200);
        } else if (stage === 'management') {
          setProblemList(data.problem_list);
          setTriageOutput(data.triage_output);
          setSessionState('complete');
          Vibration.vibrate([100, 100, 100, 100, 300]);
        }
      }),

      wsService.on('transcript', ({text, is_final}) => {
        if (is_final) setLiveTranscript(prev => prev + text + ' ');
      }),

      wsService.on('error', (err) => {
        console.error('[LiveConsultation] Error:', err);
        if (err.code === 'HISTORY_STAGE_ERROR' || err.code === 'DIAGNOSIS_STAGE_ERROR' || err.code === 'MANAGEMENT_STAGE_ERROR') {
          setIsProcessing(false);
          Alert.alert('Pipeline Error', err.message || 'An error occurred during analysis. Please try again.');
        }
      }),

      wsService.on('session_closed', (msg) => {
        setSessionState('complete');
      }),
    ];

    return () => unsubs.forEach(fn => fn());
  }, []);

  // ---------------------------------------------------------------------------
  // Audio recording
  // ---------------------------------------------------------------------------

  const startRecording = useCallback(async () => {
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission Required', 'Microphone permission is needed.');
        return;
      }

      // Reset audio mode first (fixes iOS session conflicts)
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: false,
        });
      } catch {}

      // Small delay to let iOS release the session
      await new Promise(r => setTimeout(r, 200));

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      recordingRef.current = recording;
      setIsRecording(true);
      setRecordingSeconds(0);

      recordingIntervalRef.current = setInterval(() => {
        setRecordingSeconds(s => s + 1);
      }, 1000);
    } catch (err) {
      console.error('Recording error:', err);
      Alert.alert('Error', 'Failed to start recording.');
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    if (recordingRef.current) {
      try {
        await recordingRef.current.stopAndUnloadAsync();
        const uri = recordingRef.current.getURI();
        recordingRef.current = null;
        setIsRecording(false);
        return uri;
      } catch (err) {
        console.error('Stop recording error:', err);
        recordingRef.current = null;
        setIsRecording(false);
      }
    }
    return null;
  }, []);

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  const handleStartSession = useCallback(async () => {
    if (!patientName.trim() || !patientId.trim()) {
      Alert.alert('Required', 'Enter Patient Name and ID');
      return;
    }

    setSessionState('connecting');
    try {
      const token = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
      if (!token) { Alert.alert('Auth Error', 'Please log in again.'); setSessionState('idle'); return; }

      wsService.setServerUrl(API_BASE);
      wsService.connect(token);

      // Wait for connection then init
      const waitForConnect = () => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
        const unsub = wsService.on('connection_state', ({state}) => {
          if (state === 'connected') { clearTimeout(timeout); unsub(); resolve(); }
        });
      });

      await waitForConnect();
      // Small delay to ensure WS handler is fully attached on server side
      await new Promise(r => setTimeout(r, 300));
      console.log('[LiveConsultation] WS connected, sending init...');
      const sent = wsService.initSession(patientId.trim(), patientName.trim());
      console.log('[LiveConsultation] initSession sent:', sent);
    } catch (err) {
      console.error('Session start error:', err);
      Alert.alert('Connection Failed', 'Could not connect to the server. Check your network and try again.');
      setSessionState('idle');
      wsService.disconnect();
    }
  }, [patientName, patientId]);

  const handleMarker = useCallback(async () => {
    const phaseInfo = PHASE_LABELS[currentPhase];
    if (!phaseInfo) return;

    setIsProcessing(true);
    setStreamingText('');
    setStreamingLabel('Uploading audio...');

    // Stop current recording
    const audioUri = await stopRecording();

    // Upload audio file to server for transcription
    if (audioUri && sessionId) {
      try {
        const token = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
        const formData = new FormData();
        formData.append('audio', {
          uri: audioUri,
          name: `phase_${currentPhase}.m4a`,
          type: 'audio/mp4',
        });
        formData.append('phase', String(currentPhase));

        console.log(`[LiveConsultation] Uploading phase ${currentPhase} audio...`);
        setStreamingLabel('Transcribing audio...');

        const uploadResponse = await fetch(
          `${API_BASE}/api/session/${sessionId}/upload-audio`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData,
          }
        );

        const uploadResult = await uploadResponse.json();
        if (uploadResult.success) {
          console.log(`[LiveConsultation] Transcript received: "${(uploadResult.transcript || '').slice(0, 80)}..."`);
          setLiveTranscript(prev => prev + `\n[Phase ${currentPhase}]: ${uploadResult.transcript || '(no speech detected)'}\n`);
        } else {
          console.warn('[LiveConsultation] Upload failed:', uploadResult.error);
        }
      } catch (err) {
        console.error('[LiveConsultation] Audio upload error:', err);
      }
    }

    // Send marker to trigger LLM pipeline
    setStreamingLabel('AI is analyzing...');
    const elapsed = sessionStartRef.current ? Math.round((Date.now() - sessionStartRef.current) / 1000) : 0;
    wsService.sendMarker(phaseInfo.marker, elapsed);

    // Start recording for next phase (if not last)
    if (currentPhase < 3) {
      setTimeout(() => startRecording(), 500);
    }
  }, [currentPhase, stopRecording, startRecording, sessionId]);

  const handleEndSession = useCallback(async () => {
    await stopRecording();
    const elapsed = sessionStartRef.current ? Math.round((Date.now() - sessionStartRef.current) / 1000) : 0;
    wsService.endSession(elapsed);
    wsService.disconnect();
  }, [stopRecording]);

  const handleNewSession = useCallback(() => {
    setSessionState('idle');
    setPatientName('');
    setPatientId('');
    setCurrentPhase(1);
    setStreamingText('');
    setStreamingLabel('');
    setQuestionnaire(null);
    setDifferential(null);
    setClarifyingQs(null);
    setProblemList(null);
    setTriageOutput(null);
    setLiveTranscript('');
    setRecordingSeconds(0);
    setSessionId(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Format time
  // ---------------------------------------------------------------------------

  const formatTime = (s) => `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  // ---------------------------------------------------------------------------
  // Render — Idle (patient input)
  // ---------------------------------------------------------------------------

  if (sessionState === 'idle' || sessionState === 'connecting') {
    return (
      <SafeAreaView style={s.safe}>
        <ScrollView style={s.scroll} contentContainerStyle={s.idleContent}>
          <View style={s.heroCard}>
            <View style={s.heroIcon}>
              <Ionicons name="pulse" size={40} color="#0D9488" />
            </View>
            <Text style={s.heroTitle}>Live Consultation</Text>
            <Text style={s.heroSub}>AI-powered clinical co-pilot — guides you step by step</Text>
          </View>

          <View style={s.inputCard}>
            <Text style={s.inputLabel}>Patient Name</Text>
            <TextInput style={s.input} value={patientName} onChangeText={setPatientName} placeholder="Enter patient name" placeholderTextColor="#94A3B8" />

            <Text style={s.inputLabel}>Patient ID</Text>
            <TextInput style={s.input} value={patientId} onChangeText={setPatientId} placeholder="Enter patient ID" placeholderTextColor="#94A3B8" />

            <TouchableOpacity
              style={[s.startBtn, (!patientName.trim() || !patientId.trim()) && s.startBtnDisabled]}
              onPress={handleStartSession}
              disabled={sessionState === 'connecting' || !patientName.trim() || !patientId.trim()}
            >
              {sessionState === 'connecting' ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="radio-outline" size={22} color="#fff" />
                  <Text style={s.startBtnText}>Start Live Session</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          <View style={s.stepsCard}>
            <Text style={s.stepsTitle}>How it works</Text>
            {[
              {icon: 'chatbubble', text: 'Phase 1: Ask patient name, age, village & chief complaint (~30s)'},
              {icon: 'clipboard', text: 'Phase 2: AI generates a questionnaire — read it to the patient'},
              {icon: 'medkit', text: 'Phase 3: AI produces diagnosis, prescription & triage decision'},
            ].map((step, i) => (
              <View key={i} style={s.stepRow}>
                <View style={s.stepIcon}><Ionicons name={step.icon} size={16} color="#0D9488" /></View>
                <Text style={s.stepText}>{step.text}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — Active session
  // ---------------------------------------------------------------------------

  const phaseInfo = PHASE_LABELS[currentPhase] || {};

  return (
    <SafeAreaView style={s.safe}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <View style={[s.liveDot, connectionState === 'connected' ? s.liveDotOn : s.liveDotOff]} />
          <Text style={s.headerTitle}>{patientName}</Text>
        </View>
        <Text style={s.headerTime}>{formatTime(recordingSeconds)}</Text>
      </View>

      {/* Phase indicator */}
      <PhaseIndicator currentPhase={currentPhase} />

      {/* Scrollable content */}
      <ScrollView ref={scrollRef} style={s.scroll} contentContainerStyle={s.contentPad}>
        {/* Phase instruction */}
        {sessionState === 'active' && (
          <View style={s.phaseCard}>
            <Text style={s.phaseTitle}>{phaseInfo.title}</Text>
            <Text style={s.phaseInstruction}>{phaseInfo.instruction}</Text>
          </View>
        )}

        {/* Recording indicator */}
        {isRecording && sessionState === 'active' && (
          <View style={s.recordingBar}>
            <View style={s.recordingDot} />
            <Text style={s.recordingText}>Recording — speak clearly</Text>
          </View>
        )}

        {/* Live transcript */}
        {liveTranscript.length > 0 && (
          <View style={s.transcriptBox}>
            <Text style={s.transcriptLabel}>Live Transcript</Text>
            <Text style={s.transcriptText}>{liveTranscript}</Text>
          </View>
        )}

        {/* Streaming AI output */}
        {streamingText.length > 0 && (
          <StreamingText text={streamingText} label={streamingLabel} />
        )}

        {/* Processing indicator */}
        {isProcessing && !streamingText && (
          <View style={s.processingBox}>
            <ActivityIndicator color="#0D9488" size="small" />
            <Text style={s.processingText}>AI is analyzing...</Text>
          </View>
        )}

        {/* Phase 1 result: Questionnaire */}
        {questionnaire && <QuestionnaireCard data={questionnaire} />}

        {/* Phase 2 results: Differential + Clarifying */}
        {differential && <DifferentialCard data={differential} />}
        {clarifyingQs && <ClarifyingCard data={clarifyingQs} />}

        {/* Phase 3 results: Problem list + Triage */}
        {problemList && <PrescriptionCard data={problemList} />}
        {triageOutput && <TriageCard data={triageOutput} />}

        {/* Complete state */}
        {sessionState === 'complete' && (
          <View style={s.completeCard}>
            <Ionicons name="checkmark-circle" size={48} color="#10B981" />
            <Text style={s.completeTitle}>Consultation Complete</Text>
            <Text style={s.completeSub}>Session ID: {sessionId}</Text>
            <TouchableOpacity style={s.newSessionBtn} onPress={handleNewSession}>
              <Text style={s.newSessionText}>Start New Consultation</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{height: 120}} />
      </ScrollView>

      {/* Bottom action bar */}
      {sessionState === 'active' && (
        <View style={s.bottomBar}>
          <TouchableOpacity
            style={[s.markerBtn, isProcessing && s.markerBtnDisabled]}
            onPress={handleMarker}
            disabled={isProcessing}
          >
            <Ionicons name="checkmark-circle" size={24} color="#fff" />
            <Text style={s.markerBtnText}>{phaseInfo.next}</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#F8FAFC'},
  scroll: {flex: 1},
  idleContent: {padding: 20},
  contentPad: {padding: 16},

  // Hero
  heroCard: {alignItems: 'center', paddingVertical: 32, paddingHorizontal: 20, backgroundColor: '#fff', borderRadius: 16, marginBottom: 16, shadowColor: '#0D9488', shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.1, shadowRadius: 12, elevation: 4},
  heroIcon: {width: 72, height: 72, borderRadius: 36, backgroundColor: '#F0FDFA', alignItems: 'center', justifyContent: 'center', marginBottom: 16},
  heroTitle: {fontSize: 24, fontWeight: '800', color: '#0F172A', marginBottom: 6},
  heroSub: {fontSize: 14, color: '#64748B', textAlign: 'center'},

  // Inputs
  inputCard: {backgroundColor: '#fff', borderRadius: 16, padding: 20, marginBottom: 16, shadowColor: '#000', shadowOffset: {width: 0, height: 1}, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2},
  inputLabel: {fontSize: 13, fontWeight: '600', color: '#475569', marginBottom: 6, marginTop: 8},
  input: {backgroundColor: '#F1F5F9', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: '#1E293B', borderWidth: 1, borderColor: '#E2E8F0'},
  startBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0D9488', borderRadius: 12, paddingVertical: 16, marginTop: 20},
  startBtnDisabled: {backgroundColor: '#94A3B8'},
  startBtnText: {fontSize: 16, fontWeight: '700', color: '#fff', marginLeft: 8},

  // Steps
  stepsCard: {backgroundColor: '#fff', borderRadius: 16, padding: 20, shadowColor: '#000', shadowOffset: {width: 0, height: 1}, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2},
  stepsTitle: {fontSize: 16, fontWeight: '700', color: '#0F172A', marginBottom: 12},
  stepRow: {flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12},
  stepIcon: {width: 32, height: 32, borderRadius: 16, backgroundColor: '#F0FDFA', alignItems: 'center', justifyContent: 'center', marginRight: 12},
  stepText: {flex: 1, fontSize: 13, color: '#475569', lineHeight: 20},

  // Header
  header: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#E2E8F0'},
  headerLeft: {flexDirection: 'row', alignItems: 'center'},
  liveDot: {width: 10, height: 10, borderRadius: 5, marginRight: 8},
  liveDotOn: {backgroundColor: '#10B981'},
  liveDotOff: {backgroundColor: '#EF4444'},
  headerTitle: {fontSize: 16, fontWeight: '700', color: '#0F172A'},
  headerTime: {fontSize: 18, fontWeight: '700', color: '#0D9488', fontVariant: ['tabular-nums']},

  // Phase card
  phaseCard: {backgroundColor: '#EFF6FF', borderRadius: 12, padding: 14, marginBottom: 12, borderLeftWidth: 4, borderLeftColor: '#3B82F6'},
  phaseTitle: {fontSize: 15, fontWeight: '700', color: '#1E40AF', marginBottom: 4},
  phaseInstruction: {fontSize: 13, color: '#3730A3', lineHeight: 20},

  // Recording
  recordingBar: {flexDirection: 'row', alignItems: 'center', backgroundColor: '#FEF2F2', borderRadius: 8, padding: 10, marginBottom: 8},
  recordingDot: {width: 10, height: 10, borderRadius: 5, backgroundColor: '#EF4444', marginRight: 8},
  recordingText: {fontSize: 13, color: '#991B1B', fontWeight: '500'},

  // Transcript
  transcriptBox: {backgroundColor: '#F1F5F9', borderRadius: 10, padding: 12, marginBottom: 8},
  transcriptLabel: {fontSize: 11, fontWeight: '700', color: '#64748B', marginBottom: 4, textTransform: 'uppercase'},
  transcriptText: {fontSize: 13, color: '#334155', lineHeight: 20},

  // Processing
  processingBox: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 20},
  processingText: {fontSize: 14, color: '#0D9488', marginLeft: 8, fontWeight: '500'},

  // Bottom bar
  bottomBar: {position: 'absolute', bottom: 0, left: 0, right: 0, padding: 16, paddingBottom: Platform.OS === 'ios' ? 34 : 16, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#E2E8F0'},
  markerBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0D9488', borderRadius: 14, paddingVertical: 16},
  markerBtnDisabled: {backgroundColor: '#94A3B8'},
  markerBtnText: {fontSize: 16, fontWeight: '700', color: '#fff', marginLeft: 8},

  // Complete
  completeCard: {alignItems: 'center', paddingVertical: 30},
  completeTitle: {fontSize: 20, fontWeight: '800', color: '#10B981', marginTop: 12},
  completeSub: {fontSize: 13, color: '#64748B', marginTop: 4},
  newSessionBtn: {backgroundColor: '#0D9488', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 14, marginTop: 20},
  newSessionText: {fontSize: 15, fontWeight: '700', color: '#fff'},
});

export default LiveConsultationScreen;
