/**
 * Live Consultation — UI Components
 * ====================================
 * Reusable cards for the real-time clinical pipeline display.
 */

import React, {useEffect, useRef} from 'react';
import {View, Text, StyleSheet, ScrollView, Animated} from 'react-native';
import {Ionicons} from '@expo/vector-icons';

// ---------------------------------------------------------------------------
// Phase Indicator
// ---------------------------------------------------------------------------

export const PhaseIndicator = ({currentPhase}) => {
  const phases = [
    {key: 1, label: 'History', icon: 'chatbubble-ellipses'},
    {key: 2, label: 'Interview', icon: 'clipboard'},
    {key: 3, label: 'Assessment', icon: 'medkit'},
  ];

  return (
    <View style={pi.container}>
      {phases.map((p, i) => {
        const isActive = currentPhase === p.key;
        const isDone = currentPhase > p.key;
        return (
          <React.Fragment key={p.key}>
            {i > 0 && (
              <View style={[pi.line, isDone && pi.lineDone]} />
            )}
            <View style={[pi.dot, isActive && pi.dotActive, isDone && pi.dotDone]}>
              <Ionicons
                name={isDone ? 'checkmark' : p.icon}
                size={16}
                color={isActive || isDone ? '#fff' : '#94A3B8'}
              />
            </View>
            <Text style={[pi.label, isActive && pi.labelActive, isDone && pi.labelDone]}>
              {p.label}
            </Text>
          </React.Fragment>
        );
      })}
    </View>
  );
};

const pi = StyleSheet.create({
  container: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 16, paddingHorizontal: 20},
  dot: {width: 36, height: 36, borderRadius: 18, backgroundColor: '#E2E8F0', alignItems: 'center', justifyContent: 'center'},
  dotActive: {backgroundColor: '#0D9488', shadowColor: '#0D9488', shadowOffset: {width: 0, height: 0}, shadowOpacity: 0.4, shadowRadius: 8, elevation: 4},
  dotDone: {backgroundColor: '#10B981'},
  line: {height: 2, flex: 1, backgroundColor: '#E2E8F0', marginHorizontal: 4},
  lineDone: {backgroundColor: '#10B981'},
  label: {position: 'absolute', bottom: -2, fontSize: 10, color: '#94A3B8', fontWeight: '500'},
  labelActive: {color: '#0D9488', fontWeight: '700'},
  labelDone: {color: '#10B981'},
});

// ---------------------------------------------------------------------------
// Streaming Text (typewriter effect)
// ---------------------------------------------------------------------------

export const StreamingText = ({text, label}) => {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, {toValue: 1, duration: 300, useNativeDriver: true}).start();
  }, []);

  if (!text) return null;
  return (
    <Animated.View style={[st.container, {opacity}]}>
      {label && <Text style={st.label}>{label}</Text>}
      <Text style={st.text}>{text}</Text>
      <View style={st.cursor} />
    </Animated.View>
  );
};

const st = StyleSheet.create({
  container: {backgroundColor: '#F0FDFA', borderRadius: 12, padding: 16, marginVertical: 8, borderLeftWidth: 3, borderLeftColor: '#0D9488'},
  label: {fontSize: 12, fontWeight: '700', color: '#0D9488', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5},
  text: {fontSize: 14, lineHeight: 22, color: '#1E293B'},
  cursor: {width: 8, height: 16, backgroundColor: '#0D9488', borderRadius: 2, marginTop: 4, opacity: 0.6},
});

// ---------------------------------------------------------------------------
// Questionnaire Card
// ---------------------------------------------------------------------------

export const QuestionnaireCard = ({data}) => {
  if (!data || !data.sections) return null;
  return (
    <View style={qc.container}>
      <View style={qc.header}>
        <Ionicons name="clipboard-outline" size={20} color="#0D9488" />
        <Text style={qc.title}>Interview Questionnaire</Text>
      </View>
      {data.opening_context && <Text style={qc.context}>{data.opening_context}</Text>}
      {data.sections.map((section, si) => (
        <View key={si} style={qc.section}>
          <Text style={qc.sectionTitle}>{section.section_title}</Text>
          {section.rationale ? <Text style={qc.rationale}>{section.rationale}</Text> : null}
          {(section.questions || []).map((q, qi) => (
            <View key={qi} style={qc.question}>
              <Text style={qc.qNum}>{qi + 1}.</Text>
              <View style={qc.qBody}>
                <Text style={qc.qText}>{q.question}</Text>
                {q.follow_up ? <Text style={qc.followUp}>↳ {q.follow_up}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      ))}
      {data.mandatory_safety_questions?.length > 0 && (
        <View style={qc.safetySection}>
          <Text style={qc.safetyTitle}>⚠️ Mandatory Safety Questions</Text>
          {data.mandatory_safety_questions.map((q, i) => (
            <Text key={i} style={qc.safetyQ}>• {q.question}</Text>
          ))}
        </View>
      )}
    </View>
  );
};

const qc = StyleSheet.create({
  container: {backgroundColor: '#fff', borderRadius: 12, padding: 16, marginVertical: 8, shadowColor: '#000', shadowOffset: {width: 0, height: 1}, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2},
  header: {flexDirection: 'row', alignItems: 'center', marginBottom: 12},
  title: {fontSize: 16, fontWeight: '700', color: '#1E293B', marginLeft: 8},
  context: {fontSize: 13, color: '#64748B', marginBottom: 12, fontStyle: 'italic'},
  section: {marginBottom: 16, borderTopWidth: 1, borderTopColor: '#F1F5F9', paddingTop: 12},
  sectionTitle: {fontSize: 14, fontWeight: '700', color: '#0F172A', marginBottom: 4},
  rationale: {fontSize: 11, color: '#94A3B8', marginBottom: 8, fontStyle: 'italic'},
  question: {flexDirection: 'row', marginBottom: 8, paddingLeft: 4},
  qNum: {fontSize: 13, fontWeight: '700', color: '#0D9488', width: 20, marginTop: 1},
  qBody: {flex: 1},
  qText: {fontSize: 13, color: '#1E293B', lineHeight: 20},
  followUp: {fontSize: 12, color: '#64748B', marginTop: 2, fontStyle: 'italic'},
  safetySection: {backgroundColor: '#FEF3C7', borderRadius: 8, padding: 12, marginTop: 8},
  safetyTitle: {fontSize: 13, fontWeight: '700', color: '#92400E', marginBottom: 6},
  safetyQ: {fontSize: 13, color: '#78350F', marginBottom: 4},
});

// ---------------------------------------------------------------------------
// Differential Diagnosis Card
// ---------------------------------------------------------------------------

export const DifferentialCard = ({data}) => {
  if (!data || !data.length) return null;
  return (
    <View style={dc.container}>
      <View style={dc.header}>
        <Ionicons name="analytics-outline" size={20} color="#7C3AED" />
        <Text style={dc.title}>Differential Diagnosis</Text>
      </View>
      {data.map((d, i) => (
        <View key={i} style={dc.row}>
          <View style={dc.rankBadge}>
            <Text style={dc.rankText}>{d.rank || i + 1}</Text>
          </View>
          <View style={dc.info}>
            <View style={dc.nameRow}>
              <Text style={dc.disease}>{d.disease}</Text>
              {d.must_not_miss && <View style={dc.mnmBadge}><Text style={dc.mnmText}>MNM</Text></View>}
              {d.referral_required && <View style={dc.refBadge}><Text style={dc.refText}>REF</Text></View>}
            </View>
            <View style={dc.probRow}>
              <View style={[dc.probDot, d.probability === 'high' ? dc.probHigh : d.probability === 'moderate' ? dc.probMod : dc.probLow]} />
              <Text style={dc.probText}>{d.probability}</Text>
              <Text style={dc.icd}>{d.icd10_code}</Text>
            </View>
            <Text style={dc.reasoning} numberOfLines={2}>{d.reasoning}</Text>
          </View>
        </View>
      ))}
    </View>
  );
};

const dc = StyleSheet.create({
  container: {backgroundColor: '#fff', borderRadius: 12, padding: 16, marginVertical: 8, shadowColor: '#000', shadowOffset: {width: 0, height: 1}, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2},
  header: {flexDirection: 'row', alignItems: 'center', marginBottom: 12},
  title: {fontSize: 16, fontWeight: '700', color: '#1E293B', marginLeft: 8},
  row: {flexDirection: 'row', marginBottom: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#F1F5F9'},
  rankBadge: {width: 28, height: 28, borderRadius: 14, backgroundColor: '#EDE9FE', alignItems: 'center', justifyContent: 'center', marginRight: 10},
  rankText: {fontSize: 13, fontWeight: '700', color: '#7C3AED'},
  info: {flex: 1},
  nameRow: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap'},
  disease: {fontSize: 14, fontWeight: '600', color: '#0F172A', marginRight: 6},
  mnmBadge: {backgroundColor: '#FEE2E2', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, marginRight: 4},
  mnmText: {fontSize: 9, fontWeight: '800', color: '#DC2626'},
  refBadge: {backgroundColor: '#FEF3C7', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1},
  refText: {fontSize: 9, fontWeight: '800', color: '#D97706'},
  probRow: {flexDirection: 'row', alignItems: 'center', marginTop: 3},
  probDot: {width: 8, height: 8, borderRadius: 4, marginRight: 4},
  probHigh: {backgroundColor: '#DC2626'},
  probMod: {backgroundColor: '#F59E0B'},
  probLow: {backgroundColor: '#10B981'},
  probText: {fontSize: 11, color: '#64748B', marginRight: 8, textTransform: 'capitalize'},
  icd: {fontSize: 11, color: '#94A3B8', fontFamily: 'monospace'},
  reasoning: {fontSize: 12, color: '#64748B', marginTop: 4, lineHeight: 18},
});

// ---------------------------------------------------------------------------
// Clarifying Questions Card
// ---------------------------------------------------------------------------

export const ClarifyingCard = ({data}) => {
  if (!data) return null;
  const qs = data.clarifying_questions || [];
  const obs = data.bedside_observations || [];
  return (
    <View style={cc.container}>
      <View style={cc.header}>
        <Ionicons name="help-circle-outline" size={20} color="#D97706" />
        <Text style={cc.title}>Clarifying Questions & Observations</Text>
      </View>
      {data.key_uncertainty && <Text style={cc.uncertainty}>Key uncertainty: {data.key_uncertainty}</Text>}
      {qs.map((q, i) => (
        <View key={i} style={cc.item}>
          <Text style={cc.priority}>P{q.priority}</Text>
          <View style={cc.body}>
            <Text style={cc.qText}>{q.question}</Text>
            <Text style={cc.disc}>Discriminates: {(q.discriminates_between || []).join(' vs ')}</Text>
          </View>
        </View>
      ))}
      {obs.length > 0 && (
        <>
          <Text style={cc.obsHeader}>Bedside Observations</Text>
          {obs.map((o, i) => (
            <View key={i} style={cc.item}>
              <Ionicons name="eye-outline" size={14} color="#64748B" style={{marginRight: 8, marginTop: 2}} />
              <View style={cc.body}>
                <Text style={cc.qText}>{o.observation}</Text>
                <Text style={cc.disc}>Tool: {o.tool_required} — {o.finding_and_meaning}</Text>
              </View>
            </View>
          ))}
        </>
      )}
    </View>
  );
};

const cc = StyleSheet.create({
  container: {backgroundColor: '#FFFBEB', borderRadius: 12, padding: 16, marginVertical: 8, borderWidth: 1, borderColor: '#FDE68A'},
  header: {flexDirection: 'row', alignItems: 'center', marginBottom: 10},
  title: {fontSize: 15, fontWeight: '700', color: '#92400E', marginLeft: 8},
  uncertainty: {fontSize: 12, color: '#B45309', fontStyle: 'italic', marginBottom: 10},
  item: {flexDirection: 'row', marginBottom: 10},
  priority: {fontSize: 11, fontWeight: '800', color: '#D97706', width: 24, marginTop: 2},
  body: {flex: 1},
  qText: {fontSize: 13, color: '#1E293B', fontWeight: '500'},
  disc: {fontSize: 11, color: '#78350F', marginTop: 2},
  obsHeader: {fontSize: 13, fontWeight: '700', color: '#92400E', marginTop: 8, marginBottom: 6},
});

// ---------------------------------------------------------------------------
// Prescription / Problem List Card
// ---------------------------------------------------------------------------

export const PrescriptionCard = ({data}) => {
  if (!data || !data.problem_list) return null;
  return (
    <View style={pc.container}>
      <View style={pc.header}>
        <Ionicons name="medical-outline" size={20} color="#059669" />
        <Text style={pc.title}>Management Plan</Text>
      </View>
      {data.problem_list.map((p, i) => (
        <View key={i} style={pc.problem}>
          <View style={pc.probHeader}>
            <Text style={pc.probNum}>#{p.problem_number}</Text>
            <Text style={pc.probTitle}>{p.problem_title}</Text>
            <View style={[pc.typeBadge, p.type === 'acute_new' ? pc.typeAcute : pc.typeOther]}>
              <Text style={pc.typeText}>{p.type?.replace('_', ' ')}</Text>
            </View>
          </View>
          {p.assessment?.provisional_diagnosis && (
            <Text style={pc.dx}>Dx: {p.assessment.provisional_diagnosis} ({p.assessment.confidence || '?'})</Text>
          )}
          {(p.plan?.prescription || []).map((rx, ri) => (
            <View key={ri} style={pc.rxRow}>
              <Ionicons name="tablet-portrait-outline" size={12} color="#059669" />
              <Text style={pc.rxText}>{rx.drug} {rx.dose} {rx.route} {rx.frequency} × {rx.duration}</Text>
            </View>
          ))}
          {(p.plan?.non_pharmacological || []).map((np, ni) => (
            <Text key={ni} style={pc.npText}>• {np}</Text>
          ))}
        </View>
      ))}
    </View>
  );
};

const pc = StyleSheet.create({
  container: {backgroundColor: '#fff', borderRadius: 12, padding: 16, marginVertical: 8, shadowColor: '#000', shadowOffset: {width: 0, height: 1}, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2},
  header: {flexDirection: 'row', alignItems: 'center', marginBottom: 12},
  title: {fontSize: 16, fontWeight: '700', color: '#1E293B', marginLeft: 8},
  problem: {marginBottom: 14, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: '#F1F5F9'},
  probHeader: {flexDirection: 'row', alignItems: 'center', marginBottom: 6},
  probNum: {fontSize: 13, fontWeight: '800', color: '#059669', marginRight: 6},
  probTitle: {fontSize: 14, fontWeight: '600', color: '#0F172A', flex: 1},
  typeBadge: {borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2},
  typeAcute: {backgroundColor: '#FEE2E2'},
  typeOther: {backgroundColor: '#E0E7FF'},
  typeText: {fontSize: 9, fontWeight: '700', color: '#64748B', textTransform: 'uppercase'},
  dx: {fontSize: 13, color: '#334155', marginBottom: 6},
  rxRow: {flexDirection: 'row', alignItems: 'center', marginBottom: 3, paddingLeft: 4},
  rxText: {fontSize: 12, color: '#1E293B', marginLeft: 6},
  npText: {fontSize: 12, color: '#64748B', paddingLeft: 4, marginBottom: 2},
});

// ---------------------------------------------------------------------------
// Triage Card
// ---------------------------------------------------------------------------

export const TriageCard = ({data}) => {
  if (!data || !data.triage) return null;
  const tier = data.triage.tier || 'unknown';
  const isHigh = tier === 'HIGH';
  const pi2 = data.patient_instructions || {};
  const dh = data.doctor_handoff || {};

  return (
    <View style={tc.container}>
      {/* Risk Tier Banner */}
      <View style={[tc.banner, isHigh ? tc.bannerHigh : tc.bannerLow]}>
        <Ionicons name={isHigh ? 'warning' : 'shield-checkmark'} size={24} color="#fff" />
        <View style={tc.bannerText}>
          <Text style={tc.tierLabel}>Risk Tier: {tier}</Text>
          <Text style={tc.tierAction}>{data.triage.action}</Text>
        </View>
      </View>

      {/* Referral */}
      {data.triage.referral?.required && (
        <View style={tc.referralBox}>
          <Text style={tc.referralTitle}>🏥 Referral Required</Text>
          <Text style={tc.referralText}>Urgency: {data.triage.referral.urgency}</Text>
          <Text style={tc.referralText}>Facility: {data.triage.referral.facility}</Text>
          <Text style={tc.referralText}>Reason: {data.triage.referral.reason}</Text>
        </View>
      )}

      {/* Patient Instructions */}
      {pi2.diagnosis_explained && (
        <View style={tc.section}>
          <Text style={tc.sectionTitle}>📋 Patient Instructions</Text>
          <Text style={tc.explained}>{pi2.diagnosis_explained}</Text>
          <Text style={tc.rxSummary}>{pi2.treatment_summary}</Text>
          {(pi2.do_list || []).length > 0 && (
            <View style={tc.list}>
              <Text style={tc.listTitle}>✅ Do:</Text>
              {pi2.do_list.map((d, i) => <Text key={i} style={tc.listItem}>• {d}</Text>)}
            </View>
          )}
          {(pi2.dont_list || []).length > 0 && (
            <View style={tc.list}>
              <Text style={tc.listTitle}>🚫 Don't:</Text>
              {pi2.dont_list.map((d, i) => <Text key={i} style={tc.listItem}>• {d}</Text>)}
            </View>
          )}
          {(pi2.return_criteria || []).length > 0 && (
            <View style={[tc.list, tc.returnBox]}>
              <Text style={tc.returnTitle}>⚠️ Return immediately if:</Text>
              {pi2.return_criteria.map((r, i) => <Text key={i} style={tc.returnItem}>• {r}</Text>)}
            </View>
          )}
          {pi2.follow_up && <Text style={tc.followUp}>Follow-up: {pi2.follow_up}</Text>}
        </View>
      )}

      {/* Doctor Handoff */}
      {dh.one_liner && (
        <View style={tc.handoffSection}>
          <Text style={tc.handoffTitle}>👨‍⚕️ Doctor Handoff</Text>
          <Text style={tc.oneLiner}>{dh.one_liner}</Text>
          {dh.authorization_required_by && (
            <Text style={tc.authBy}>Auth required by: {dh.authorization_required_by}</Text>
          )}
        </View>
      )}
    </View>
  );
};

const tc = StyleSheet.create({
  container: {marginVertical: 8},
  banner: {borderRadius: 12, padding: 16, flexDirection: 'row', alignItems: 'center'},
  bannerHigh: {backgroundColor: '#DC2626'},
  bannerLow: {backgroundColor: '#059669'},
  bannerText: {marginLeft: 12, flex: 1},
  tierLabel: {fontSize: 18, fontWeight: '800', color: '#fff'},
  tierAction: {fontSize: 13, color: 'rgba(255,255,255,0.9)', marginTop: 2},
  referralBox: {backgroundColor: '#FEF2F2', borderRadius: 10, padding: 12, marginTop: 8, borderWidth: 1, borderColor: '#FECACA'},
  referralTitle: {fontSize: 14, fontWeight: '700', color: '#991B1B', marginBottom: 4},
  referralText: {fontSize: 13, color: '#7F1D1D', marginBottom: 2},
  section: {backgroundColor: '#fff', borderRadius: 12, padding: 16, marginTop: 8, shadowColor: '#000', shadowOffset: {width: 0, height: 1}, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2},
  sectionTitle: {fontSize: 15, fontWeight: '700', color: '#1E293B', marginBottom: 8},
  explained: {fontSize: 14, color: '#334155', lineHeight: 22, marginBottom: 8},
  rxSummary: {fontSize: 13, color: '#475569', lineHeight: 20, marginBottom: 10, backgroundColor: '#F8FAFC', padding: 10, borderRadius: 8},
  list: {marginBottom: 8},
  listTitle: {fontSize: 13, fontWeight: '700', color: '#334155', marginBottom: 4},
  listItem: {fontSize: 13, color: '#475569', marginBottom: 2, paddingLeft: 4},
  returnBox: {backgroundColor: '#FEF3C7', borderRadius: 8, padding: 10},
  returnTitle: {fontSize: 13, fontWeight: '700', color: '#92400E', marginBottom: 4},
  returnItem: {fontSize: 13, color: '#78350F', marginBottom: 2},
  followUp: {fontSize: 13, color: '#0D9488', fontWeight: '600', marginTop: 6},
  handoffSection: {backgroundColor: '#F0F9FF', borderRadius: 12, padding: 14, marginTop: 8, borderWidth: 1, borderColor: '#BAE6FD'},
  handoffTitle: {fontSize: 14, fontWeight: '700', color: '#0C4A6E', marginBottom: 6},
  oneLiner: {fontSize: 13, color: '#0369A1', lineHeight: 20},
  authBy: {fontSize: 12, color: '#DC2626', fontWeight: '600', marginTop: 6},
});
