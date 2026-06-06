import React, {useState, useEffect, useCallback, useMemo, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Pressable,
  Alert,
  TextInput,
  Modal,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Ionicons} from '@expo/vector-icons';
import {Swipeable} from 'react-native-gesture-handler';

import SummaryCard from '../components/dashboard/SummaryCard';
import PatientTaskCard from '../components/dashboard/PatientTaskCard';
import apiService from '../services/apiService';
import useKeyboardCentering from '../hooks/useKeyboardCentering';

const CURRENT_PATIENT_KEY = '@nurseai_current_patient';

const HomePage = ({navigation}) => {
  const [summary, setSummary] = useState({pending: 0, done: 0});
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [currentPatient, setCurrentPatient] = useState(null);
  const [geminiSuggestions, setGeminiSuggestions] = useState([]);
  const [geminiError, setGeminiError] = useState(null);
  const [expandedSuggestionId, setExpandedSuggestionId] = useState(null);
  const [askAiInputs, setAskAiInputs] = useState({});
  const [askAiLoading, setAskAiLoading] = useState({});
  const [flaggingSuggestions, setFlaggingSuggestions] = useState({});
  const [flaggedSuggestions, setFlaggedSuggestions] = useState({});
  const [flagModalVisible, setFlagModalVisible] = useState(false);
  const [flagReason, setFlagReason] = useState('');
  const [flagTarget, setFlagTarget] = useState(null);
  const [managementPlans, setManagementPlans] = useState([]);
  const [managementPlansError, setManagementPlansError] = useState(null);
  const [expandedPlanId, setExpandedPlanId] = useState(null);
  const scrollViewRef = useRef(null);
  const {onScroll, handleFocus, keyboardHeight} = useKeyboardCentering(scrollViewRef);

  // Load current patient info from storage
  useEffect(() => {
    const loadCurrentPatient = async () => {
      try {
        const patientData = await AsyncStorage.getItem(CURRENT_PATIENT_KEY);
        if (patientData) {
          setCurrentPatient(JSON.parse(patientData));
        }
      } catch (error) {
        console.error('Error loading current patient:', error);
      }
    };
    loadCurrentPatient();
    
    // Listen for focus events to refresh patient info
    const unsubscribe = navigation.addListener('focus', loadCurrentPatient);
    return unsubscribe;
  }, [navigation]);

  // Memoized fetch function - all data from backend
  const fetchDashboardData = useCallback(async (isRefresh = false) => {
    try {
      if (!isRefresh) {
        setLoading(true);
        setError(null);
      }

      // Get current patient info for filtering
      let patientParams = {};
      if (currentPatient) {
        patientParams = {
          patientName: currentPatient.patientName,
          patientId: currentPatient.patientId,
        };
      }

      // Fetch summary and tasks in parallel for better performance
      const [summaryResult, tasksResult, geminiResult, mgmtResult] = await Promise.all([
        apiService.getDashboardSummary(),
        apiService.getPatientTasks({
          sortBy: 'emergency',
          status: 'Pending',
          ...patientParams,
        }), // Sorted by emergency level with patient filter
        apiService.getGeminiSuggestions(),
        apiService.getManagementPlans(),
      ]);

      if (summaryResult.success) {
        setSummary(summaryResult.data || {pending: 0, done: 0});
      } else {
        setSummary({pending: 0, done: 0});
        setError('Failed to load dashboard summary');
      }

      if (tasksResult.success) {
        // Only use data from backend, no fallback
        setTasks(tasksResult.data || []);
      } else {
        setTasks([]);
        setError('Failed to load patient tasks');
      }

      if (geminiResult.success) {
        const suggestions = geminiResult.data || [];
        setGeminiSuggestions(suggestions.slice(0, 5));
        setGeminiError(null);
      } else {
        setGeminiSuggestions([]);
        setGeminiError(geminiResult.error || 'Failed to load Gemini suggestions');
      }

      if (mgmtResult.success) {
        setManagementPlans(mgmtResult.data || []);
        setManagementPlansError(null);
      } else {
        setManagementPlans([]);
        setManagementPlansError(mgmtResult.error || 'Failed to load management plans');
      }
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
      setSummary({pending: 0, done: 0});
      setTasks([]);
      setGeminiSuggestions([]);
      setGeminiError('Network error. Please check your connection.');
      setManagementPlans([]);
      setManagementPlansError('Network error.');
      setError('Network error. Please check your connection.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentPatient]);

  // Initial load
  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      apiService.clearCache();
      fetchDashboardData(true);
    });
    return unsubscribe;
  }, [navigation, fetchDashboardData]);

  // Pull to refresh
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    apiService.clearCache();
    fetchDashboardData(true);
  }, [fetchDashboardData]);

  // Memoized task press handler
  const handleTaskPress = useCallback((task) => {
    navigation.navigate('Transcript', {taskId: task.id, task});
  }, [navigation]);

  const handleCompleteTask = useCallback(async (taskId) => {
    const result = await apiService.completePatientTask(taskId);
    if (result.success) {
      setTasks((prev) => prev.filter((task) => task.id !== taskId));
      setSummary((prev) => ({
        pending: Math.max(0, (prev?.pending || 0) - 1),
        done: (prev?.done || 0) + 1,
      }));
    } else {
      setError(result.error || 'Failed to complete task');
    }
  }, []);

  // Memoized render functions for performance
  const renderSummaryCards = useMemo(() => (
    <View style={styles.summaryContainer}>
      <SummaryCard type="pending" count={summary.pending} label="Pending" />
      <SummaryCard type="done" count={summary.done} label="Done" />
    </View>
  ), [summary]);

  const renderTasks = useMemo(() => {
    if (tasks.length === 0) {
      return (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>
            {error ? 'Error loading tasks' : 'No tasks available'}
          </Text>
          {error && (
            <Text style={styles.errorText}>{error}</Text>
          )}
        </View>
      );
    }

    return tasks.map((task) => (
      <Swipeable
        key={task.id}
        renderLeftActions={renderLeftActions}
        onSwipeableOpen={() => handleCompleteTask(task.id)}>
        <PatientTaskCard
        task={task}
        onPress={() => handleTaskPress(task)}
      />
      </Swipeable>
    ));
  }, [tasks, handleTaskPress, handleCompleteTask, error, renderLeftActions]);

  const handleCompleteSuggestion = useCallback(async (id) => {
    const result = await apiService.completeGeminiSuggestion(id);
    if (result.success) {
      setGeminiSuggestions((prev) => prev.filter((item) => item.id !== id));
      setExpandedSuggestionId((prev) => (prev === id ? null : prev));
      setSummary((prev) => ({
        pending: Math.max(0, (prev?.pending || 0) - 1),
        done: (prev?.done || 0) + 1,
      }));
    } else {
      setGeminiError(result.error || 'Failed to mark suggestion complete');
    }
  }, []);

  const handleAskAiChange = useCallback((id, value) => {
    setAskAiInputs((prev) => ({...prev, [id]: value}));
  }, []);

  const handleAskAiSubmit = useCallback(
    async (item) => {
      const message = (askAiInputs[item.id] || '').trim();
      if (!message) {
        Alert.alert('Ask AI', 'Please enter a question before sending.');
        return;
      }
      setAskAiLoading((prev) => ({...prev, [item.id]: true}));
      const result = await apiService.followupGeminiSuggestion(
        item.id,
        message,
        item.patientId
      );
      if (result.success) {
        setGeminiSuggestions((prev) =>
          prev.map((suggestion) => {
            if (suggestion.id === item.id) {
              const newFollowups = [...(suggestion.followups || [])];
              newFollowups.push({
                question: message,
                answer: result.data?.followupAnswer || result.data?.content || ''
              });
              return {...suggestion, followups: newFollowups};
            }
            return suggestion;
          })
        );
        setAskAiInputs((prev) => ({...prev, [item.id]: ''}));
      } else {
        Alert.alert('Ask AI', result.error || 'Failed to send follow-up.');
      }
      setAskAiLoading((prev) => ({...prev, [item.id]: false}));
    },
    [askAiInputs]
  );

  const handleFlagSuggestion = useCallback(async (item) => {
    setFlagTarget(item);
    setFlagReason('');
    setFlagModalVisible(true);
  }, []);

  const submitFlagSuggestion = useCallback(async () => {
    if (!flagTarget) {
      setFlagModalVisible(false);
      return;
    }
    if (flaggingSuggestions[flagTarget.id]) {
      return;
    }
    if (!flagReason.trim()) {
      Alert.alert('Flag for review', 'Please add a reason for flagging.');
      return;
    }
    setFlaggingSuggestions((prev) => ({...prev, [flagTarget.id]: true}));
    const result = await apiService.flagGeminiSuggestion(flagTarget.id, flagReason.trim());
    if (result.success) {
      setFlaggedSuggestions((prev) => ({...prev, [flagTarget.id]: true}));
      setFlagModalVisible(false);
      Alert.alert('Flagged', 'Suggestion flagged for review.');
    } else {
      Alert.alert('Flag for review', result.error || 'Failed to flag suggestion.');
    }
    setFlaggingSuggestions((prev) => ({...prev, [flagTarget.id]: false}));
  }, [flagTarget, flagReason, flaggingSuggestions]);

  const closeFlagModal = useCallback(() => {
    setFlagModalVisible(false);
    setFlagReason('');
    setFlagTarget(null);
  }, []);

  const toggleSuggestion = useCallback((id) => {
    setExpandedSuggestionId((prev) => (prev === id ? null : id));
  }, []);

  const handleClearManagementPlan = useCallback(async (id) => {
    const result = await apiService.clearManagementPlan(id);
    if (result.success) {
      setManagementPlans((prev) => prev.filter((p) => p.id !== id));
      setExpandedPlanId((prev) => (prev === id ? null : prev));
    } else {
      setManagementPlansError(result.error || 'Failed to clear plan');
    }
  }, []);

  const togglePlan = useCallback((id) => {
    setExpandedPlanId((prev) => (prev === id ? null : id));
  }, []);

  const renderLeftActions = useCallback(() => {
    return (
      <View style={styles.swipeAction}>
        <Ionicons name="checkmark-circle" size={24} color="#FFFFFF" />
        <Text style={styles.swipeActionText}>Complete</Text>
      </View>
    );
  }, []);

  const renderGeminiSuggestions = useMemo(() => {
    if (geminiError) {
      return (
        <View style={styles.geminiCard}>
          <Text style={styles.geminiTitle}>Gemini Suggestions</Text>
          <Text style={styles.geminiError}>{geminiError}</Text>
        </View>
      );
    }

    if (geminiSuggestions.length === 0) {
      return (
        <View style={styles.geminiCard}>
          <Text style={styles.geminiTitle}>Gemini Suggestions</Text>
          <Text style={styles.geminiEmpty}>
            No pending suggestions yet.
          </Text>
        </View>
      );
    }

    return (
      <View style={styles.geminiList}>
        <Text style={styles.geminiTitle}>Gemini Suggestions</Text>
        {geminiSuggestions.map((item) => {
          const isExpanded = expandedSuggestionId === item.id;
          return (
            <Swipeable
              key={item.id}
              renderLeftActions={renderLeftActions}
              onSwipeableOpen={() => handleCompleteSuggestion(item.id)}>
              <Pressable
                onPress={() => toggleSuggestion(item.id)}
                style={styles.geminiCardItem}
                accessibilityRole="button"
                accessibilityLabel="Toggle Gemini suggestion"
                accessibilityHint="Tap to expand or collapse the suggestion text">
                <View style={styles.geminiCardHeader}>
                  <View style={{flexDirection: 'column', flex: 1}}>
                    <Text style={styles.geminiSubtitle}>
                      {item.patientName || 'Unknown Patient'} (ID: {item.patientId || 'N/A'})
                    </Text>
                    {item.verificationStatus === 'verified' && (
                      <View style={styles.verifiedBadge}>
                        <Ionicons name="shield-checkmark" size={14} color="#059669" />
                        <Text style={styles.verifiedText}>Verified Analysis</Text>
                      </View>
                    )}
                  </View>
                  <Pressable
                    style={[
                      styles.flagButton,
                      (flaggingSuggestions[item.id] || flaggedSuggestions[item.id]) &&
                        styles.flagButtonDisabled,
                    ]}
                    onPress={() => handleFlagSuggestion(item)}
                    disabled={flaggingSuggestions[item.id] || flaggedSuggestions[item.id]}>
                    <Text style={styles.flagButtonText}>
                      {flaggedSuggestions[item.id] ? 'Flagged' : 'Flag for review'}
                    </Text>
                  </Pressable>
                </View>
                <Text
                  style={styles.geminiContent}
                  numberOfLines={isExpanded ? undefined : 5}>
                  {item.content}
                </Text>

                {isExpanded && item.followups && item.followups.length > 0 && (
                  <View style={styles.followupsContainer}>
                    {item.followups.map((f, idx) => (
                      <View key={idx} style={styles.followupItem}>
                        <View style={styles.followupQuestionRow}>
                          <Ionicons name="chatbubble-ellipses" size={16} color="#0EA5E9" style={{marginTop: 2}} />
                          <Text style={styles.followupQuestionText}>Q: {f.question}</Text>
                        </View>
                        <View style={styles.followupAnswerRow}>
                          <Ionicons name="medical" size={16} color="#059669" style={{marginTop: 2}} />
                          <Text style={styles.followupAnswerText}>A: {f.answer}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                <Text style={styles.geminiHint}>
                  {isExpanded ? 'Tap to collapse' : 'Tap to expand'}
                </Text>
                {isExpanded && (
                  <View style={styles.askAiContainer}>
                    <Text style={styles.askAiLabel}>Ask AI</Text>
                    <TextInput
                      style={styles.askAiInput}
                      placeholder="Ask a follow-up question..."
                      placeholderTextColor="#999999"
                      value={askAiInputs[item.id] || ''}
                      onChangeText={(value) => handleAskAiChange(item.id, value)}
                      onFocus={handleFocus}
                      editable={!askAiLoading[item.id]}
                      multiline
                    />
                    <Pressable
                      style={[
                        styles.askAiButton,
                        (!askAiInputs[item.id]?.trim() || askAiLoading[item.id]) &&
                          styles.askAiButtonDisabled,
                      ]}
                      onPress={() => handleAskAiSubmit(item)}
                      disabled={!askAiInputs[item.id]?.trim() || askAiLoading[item.id]}>
                      <Text style={styles.askAiButtonText}>
                        {askAiLoading[item.id] ? 'Sending...' : 'Send'}
                      </Text>
                    </Pressable>
                  </View>
                )}
              </Pressable>
            </Swipeable>
          );
        })}
      </View>
    );
  }, [
    geminiSuggestions,
    geminiError,
    handleCompleteSuggestion,
    handleAskAiChange,
    handleAskAiSubmit,
    handleFlagSuggestion,
    askAiInputs,
    askAiLoading,
    flaggingSuggestions,
    flaggedSuggestions,
    renderLeftActions,
    expandedSuggestionId,
    toggleSuggestion,
  ]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#0D9488" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollView}
        contentContainerStyle={[
          styles.scrollContent,
          keyboardHeight ? {paddingBottom: keyboardHeight + 24} : null,
        ]}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        onScroll={onScroll}
        scrollEventThrottle={16}>
        {/* Logo Container */}
        <View style={styles.logoCard}>
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <Ionicons name="document-text" size={32} color="#0D9488" />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.headerTitle}>AI-CDST</Text>
              <Text style={styles.headerSubtitle}>Clinical Assistant</Text>
            </View>
          </View>
        </View>

        {/* Summary Cards */}
        {renderSummaryCards}

        {/* Gemini Suggestions */}
        {renderGeminiSuggestions}

        {/* Management Plans */}
        {managementPlans.length > 0 && (
          <View style={styles.mgmtSection}>
            <Text style={styles.mgmtSectionTitle}>Management Plans</Text>
            {managementPlans.map((plan) => {
              const isExpanded = expandedPlanId === plan.id;
              const mgmt = typeof plan.management_plan === 'string' ? JSON.parse(plan.management_plan) : (plan.management_plan || {});
              const riskTier = plan.risk_tier || mgmt.risk_tier || 'unknown';
              const triage = plan.triage_output || mgmt.triage_output;
              const problemList = plan.problem_list || mgmt.problem_list;
              const questionnaire = plan.questionnaire;
              const clarifying = plan.clarifying_questions;
              const differential = plan.differential_table;
              const chiefComplaint = plan.chief_complaint;
              const audioFiles = plan.audio_files || [];
              const audio1 = audioFiles.find(a => a.iteration === 1);
              const audio2 = audioFiles.find(a => a.iteration === 2);
              const audio3 = audioFiles.find(a => a.iteration === 3);
              const oneLiner = triage?.triage?.one_liner || triage?.one_liner || '';

              return (
                <Swipeable
                  key={plan.id}
                  renderLeftActions={renderLeftActions}
                  onSwipeableOpen={() => handleClearManagementPlan(plan.id)}>
                  <Pressable
                    onPress={() => togglePlan(plan.id)}
                    style={styles.mgmtCard}>
                    {/* Header */}
                    <View style={styles.mgmtCardHeader}>
                      <View style={{flex: 1}}>
                        <Text style={styles.mgmtPatientName}>
                          {plan.patient_name || plan.patient_id || 'Unknown'}
                        </Text>
                        <Text style={styles.mgmtPatientId}>ID: {plan.patient_id || 'N/A'}</Text>
                      </View>
                      <View style={[
                        styles.riskBadge,
                        riskTier === 'HIGH' ? styles.riskHigh : styles.riskLow,
                      ]}>
                        <Text style={[
                          styles.riskBadgeText,
                          riskTier === 'HIGH' ? styles.riskHighText : styles.riskLowText,
                        ]}>{riskTier}</Text>
                      </View>
                    </View>

                    {/* Source + Date */}
                    <View style={styles.mgmtSourceRow}>
                      <Ionicons name={plan.source === 'live' ? 'pulse' : 'cloud-upload'} size={12} color="#64748B" />
                      <Text style={styles.mgmtSourceText}>
                        {plan.source === 'live' ? 'Live Consultation' : 'Audio Upload'}
                      </Text>
                      <Text style={styles.mgmtDate}>
                        {plan.created_at ? new Date(plan.created_at).toLocaleDateString('en-IN', {day: 'numeric', month: 'short'}) : ''}
                      </Text>
                    </View>

                    {/* One-liner always visible */}
                    {oneLiner ? (
                      <Text style={styles.mgmtTriageLine} numberOfLines={isExpanded ? undefined : 2}>
                        {oneLiner}
                      </Text>
                    ) : null}

                    {/* ========== EXPANDED TIMELINE ========== */}
                    {isExpanded && (
                      <View style={styles.mgmtExpandedContent}>

                        {/* ── PHASE 1: Audio 1 + Chief Complaint + Proforma ── */}
                        <View style={styles.phaseBlock}>
                          <View style={styles.phaseHeader}>
                            <View style={[styles.phaseDot, {backgroundColor: '#3B82F6'}]} />
                            <Text style={styles.phaseTitle}>Phase 1 — Initial Description</Text>
                          </View>
                          {audio1 && (
                            <View style={styles.audioRow}>
                              <Ionicons name="mic" size={14} color="#0D9488" />
                              <Text style={styles.audioLabel}>{audio1.label || 'Audio Recording'}</Text>
                              {audio1.duration_seconds && (
                                <Text style={styles.audioDuration}>{Math.round(audio1.duration_seconds)}s</Text>
                              )}
                            </View>
                          )}
                          {audio1?.transcript && (
                            <Text style={styles.transcriptSnippet} numberOfLines={3}>
                              "{audio1.transcript.slice(0, 200)}{audio1.transcript.length > 200 ? '...' : ''}"
                            </Text>
                          )}
                          {chiefComplaint && (
                            <View style={styles.mgmtSubSection}>
                              <Text style={styles.mgmtSubTitle}>Chief Complaint</Text>
                              <Text style={styles.mgmtSubValue}>{chiefComplaint.chief_complaint || 'N/A'}</Text>
                              {chiefComplaint.duration && (
                                <Text style={styles.mgmtSubDetail}>Duration: {chiefComplaint.duration}</Text>
                              )}
                            </View>
                          )}
                          {questionnaire && (
                            <View style={styles.mgmtSubSection}>
                              <Text style={styles.mgmtSubTitle}>Proforma / Questionnaire</Text>
                              {questionnaire.sections ? questionnaire.sections.map((sec, si) => (
                                <View key={si} style={styles.proformaSection}>
                                  <Text style={styles.proformaSectionTitle}>{sec.section_name || sec.title || `Section ${si + 1}`}</Text>
                                  {(sec.questions || []).map((q, qi) => (
                                    <Text key={qi} style={styles.proformaQuestion}>• {typeof q === 'string' ? q : (q.question || q.text || JSON.stringify(q))}</Text>
                                  ))}
                                </View>
                              )) : (
                                <Text style={styles.mgmtSubContent}>{JSON.stringify(questionnaire, null, 2)}</Text>
                              )}
                            </View>
                          )}
                        </View>

                        {/* ── PHASE 2: Audio 2 + Differential + Clarifying Qs ── */}
                        <View style={styles.phaseBlock}>
                          <View style={styles.phaseHeader}>
                            <View style={[styles.phaseDot, {backgroundColor: '#F59E0B'}]} />
                            <Text style={styles.phaseTitle}>Phase 2 — Clinical Interview</Text>
                          </View>
                          {audio2 && (
                            <View style={styles.audioRow}>
                              <Ionicons name="mic" size={14} color="#0D9488" />
                              <Text style={styles.audioLabel}>{audio2.label || 'Audio Recording'}</Text>
                              {audio2.duration_seconds && (
                                <Text style={styles.audioDuration}>{Math.round(audio2.duration_seconds)}s</Text>
                              )}
                            </View>
                          )}
                          {audio2?.transcript && (
                            <Text style={styles.transcriptSnippet} numberOfLines={3}>
                              "{audio2.transcript.slice(0, 200)}{audio2.transcript.length > 200 ? '...' : ''}"
                            </Text>
                          )}
                          {differential && Array.isArray(differential) && differential.length > 0 && (
                            <View style={styles.mgmtSubSection}>
                              <Text style={styles.mgmtSubTitle}>Differential Diagnosis</Text>
                              {differential.slice(0, 5).map((dx, i) => (
                                <View key={i} style={styles.ddxRow}>
                                  <Text style={styles.ddxRank}>#{dx.rank || i + 1}</Text>
                                  <View style={{flex: 1}}>
                                    <Text style={styles.ddxName}>{dx.disease}</Text>
                                    <Text style={styles.ddxProb}>{dx.probability} · {dx.icd10_code}</Text>
                                  </View>
                                  {dx.must_not_miss && (
                                    <View style={styles.mnmBadge}><Text style={styles.mnmText}>MNM</Text></View>
                                  )}
                                </View>
                              ))}
                            </View>
                          )}
                          {clarifying && (
                            <View style={styles.mgmtSubSection}>
                              <Text style={styles.mgmtSubTitle}>Clarifying Questions</Text>
                              {(clarifying.clarifying_questions || []).map((q, i) => (
                                <Text key={i} style={styles.proformaQuestion}>
                                  {q.priority ? `[P${q.priority}] ` : ''}{q.question}
                                </Text>
                              ))}
                            </View>
                          )}
                        </View>

                        {/* ── PHASE 3: Audio 3 + Management Plan ── */}
                        <View style={styles.phaseBlock}>
                          <View style={styles.phaseHeader}>
                            <View style={[styles.phaseDot, {backgroundColor: '#10B981'}]} />
                            <Text style={styles.phaseTitle}>Phase 3 — Management</Text>
                          </View>
                          {audio3 && (
                            <View style={styles.audioRow}>
                              <Ionicons name="mic" size={14} color="#0D9488" />
                              <Text style={styles.audioLabel}>{audio3.label || 'Audio Recording'}</Text>
                              {audio3.duration_seconds && (
                                <Text style={styles.audioDuration}>{Math.round(audio3.duration_seconds)}s</Text>
                              )}
                            </View>
                          )}
                          {audio3?.transcript && (
                            <Text style={styles.transcriptSnippet} numberOfLines={3}>
                              "{audio3.transcript.slice(0, 200)}{audio3.transcript.length > 200 ? '...' : ''}"
                            </Text>
                          )}
                          {problemList && (
                            <View style={styles.mgmtSubSection}>
                              <Text style={styles.mgmtSubTitle}>Problem List</Text>
                              {(problemList.problem_list || []).map((p, i) => (
                                <View key={i} style={styles.problemRow}>
                                  <View style={styles.problemHeader}>
                                    <Text style={styles.problemName}>
                                      {p.assessment?.primary_diagnosis || p.problem || `Problem ${i + 1}`}
                                    </Text>
                                    <Text style={[styles.problemType, p.type === 'acute_new' && {color: '#DC2626'}]}>
                                      {p.type || 'unknown'}
                                    </Text>
                                  </View>
                                  {p.plan?.prescription?.length > 0 && (
                                    <View style={styles.rxList}>
                                      {p.plan.prescription.map((rx, ri) => (
                                        <Text key={ri} style={styles.rxItem}>
                                          💊 {rx.drug} {rx.dose} {rx.route} — {rx.duration}
                                        </Text>
                                      ))}
                                    </View>
                                  )}
                                </View>
                              ))}
                            </View>
                          )}
                          {triage && (
                            <View style={styles.mgmtSubSection}>
                              <Text style={styles.mgmtSubTitle}>Triage & Instructions</Text>
                              {triage.patient_instructions && (
                                <Text style={styles.mgmtSubContent}>
                                  {typeof triage.patient_instructions === 'string'
                                    ? triage.patient_instructions
                                    : (triage.patient_instructions.instructions_text || JSON.stringify(triage.patient_instructions, null, 2))}
                                </Text>
                              )}
                            </View>
                          )}
                        </View>
                      </View>
                    )}

                    <Text style={styles.geminiHint}>
                      {isExpanded ? 'Tap to collapse · Swipe to clear' : 'Tap to expand · Swipe to clear'}
                    </Text>
                  </Pressable>
                </Swipeable>
              );
            })}
          </View>
        )}

        {managementPlansError && managementPlans.length === 0 && (
          <View style={styles.geminiCard}>
            <Text style={styles.mgmtSectionTitle}>Management Plans</Text>
            <Text style={styles.geminiError}>{managementPlansError}</Text>
          </View>
        )}
      </ScrollView>
      <Modal
        visible={flagModalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeFlagModal}>
        <View style={styles.flagModalOverlay}>
          <View style={styles.flagModalCard}>
            <Text style={styles.flagModalTitle}>Flag for review</Text>
            <Text style={styles.flagModalSubtitle}>
              Sorry for the inconvenience, but please elaborate the reason for flagging.
            </Text>
            <TextInput
              style={styles.flagModalInput}
              placeholder="Type your reason here..."
              placeholderTextColor="#999999"
              value={flagReason}
              onChangeText={setFlagReason}
              onFocus={handleFocus}
              multiline
            />
            <View style={styles.flagModalActions}>
              <Pressable style={styles.flagModalCancel} onPress={closeFlagModal}>
                <Text style={styles.flagModalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.flagModalSubmit}
                onPress={submitFlagSuggestion}>
                <Text style={styles.flagModalSubmitText}>Submit</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  scrollView: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  scrollContent: {
    paddingBottom: 24,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoCard: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerIcon: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: '#E6FFFA',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 2,
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#64748B',
  },
  summaryContainer: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  tasksSection: {
    backgroundColor: '#FFFFFF',
    margin: 12,
    borderRadius: 16,
    padding: 16,
    marginTop: 8,
  },
  geminiCard: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  geminiList: {
    marginHorizontal: 12,
    marginTop: 8,
  },
  geminiCardItem: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 12,
  },
  geminiTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 6,
  },
  geminiSubtitle: {
    fontSize: 14,
    color: '#0D9488',
    marginBottom: 8,
  },
  geminiContent: {
    fontSize: 14,
    color: '#1E293B',
  },
  followupsContainer: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingTop: 12,
  },
  followupItem: {
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  followupQuestionRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  followupQuestionText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0EA5E9',
    marginLeft: 6,
    flex: 1,
  },
  followupAnswerRow: {
    flexDirection: 'row',
  },
  followupAnswerText: {
    fontSize: 13,
    color: '#334155',
    marginLeft: 6,
    flex: 1,
    lineHeight: 18,
  },
  geminiHint: {
    marginTop: 8,
    fontSize: 12,
    color: '#94A3B8',
  },
  geminiCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  flagButton: {
    backgroundColor: '#DC2626',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  flagButtonDisabled: {
    opacity: 0.6,
  },
  flagButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#D1FAE5',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  verifiedText: {
    color: '#059669',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 4,
  },
  flagModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    padding: 20,
  },
  flagModalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 18,
  },
  flagModalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 6,
  },
  flagModalSubtitle: {
    fontSize: 14,
    color: '#64748B',
    marginBottom: 12,
  },
  flagModalInput: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 90,
    fontSize: 14,
    color: '#1E293B',
    backgroundColor: '#F8FAFC',
  },
  flagModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  flagModalCancel: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    marginRight: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  flagModalCancelText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '600',
  },
  flagModalSubmit: {
    backgroundColor: '#DC2626',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  flagModalSubmitText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  askAiContainer: {
    marginTop: 12,
  },
  askAiLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E293B',
    marginBottom: 6,
  },
  askAiInput: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    fontSize: 14,
    color: '#1E293B',
    backgroundColor: '#F8FAFC',
    marginBottom: 10,
  },
  askAiButton: {
    backgroundColor: '#0D9488',
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  askAiButtonDisabled: {
    backgroundColor: '#94A3B8',
  },
  askAiButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  geminiEmpty: {
    fontSize: 14,
    color: '#94A3B8',
  },
  geminiError: {
    fontSize: 14,
    color: '#DC2626',
  },
  swipeAction: {
    backgroundColor: '#059669',
    justifyContent: 'center',
    alignItems: 'center',
    width: 110,
    borderRadius: 16,
    marginLeft: 12,
    marginTop: 8,
    marginBottom: 12,
  },
  swipeActionText: {
    color: '#FFFFFF',
    fontSize: 12,
    marginTop: 4,
  },
  sectionHeader: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 4,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: '#64748B',
  },
  emptyContainer: {
    padding: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: '#94A3B8',
  },
  errorText: {
    fontSize: 14,
    color: '#DC2626',
    marginTop: 8,
    textAlign: 'center',
  },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#DCFCE7',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: 4,
    alignSelf: 'flex-start',
    gap: 4,
  },
  verifiedText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#059669',
    letterSpacing: 0.3,
  },
  // Management Plans styles
  mgmtSection: {
    marginHorizontal: 12,
    marginTop: 8,
  },
  mgmtSectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 8,
  },
  mgmtCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 12,
  },
  mgmtCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  mgmtPatientName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1E293B',
  },
  mgmtPatientId: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  riskBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  riskHigh: {
    backgroundColor: '#FEE2E2',
  },
  riskLow: {
    backgroundColor: '#DCFCE7',
  },
  riskBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  riskHighText: {
    color: '#DC2626',
  },
  riskLowText: {
    color: '#059669',
  },
  mgmtSourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 8,
  },
  mgmtSourceText: {
    fontSize: 11,
    color: '#64748B',
    flex: 1,
  },
  mgmtDate: {
    fontSize: 11,
    color: '#94A3B8',
  },
  mgmtTriageLine: {
    fontSize: 13,
    color: '#334155',
    lineHeight: 19,
  },
  mgmtExpandedContent: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingTop: 12,
  },
  mgmtSubSection: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  mgmtSubTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0D9488',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  mgmtSubContent: {
    fontSize: 13,
    color: '#475569',
    lineHeight: 19,
  },
  mgmtSubValue: {
    fontSize: 14,
    color: '#1E293B',
    fontWeight: '600',
    marginBottom: 2,
  },
  mgmtSubDetail: {
    fontSize: 12,
    color: '#64748B',
  },

  // Phase timeline
  phaseBlock: {
    marginBottom: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  phaseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  phaseDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  phaseTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1E293B',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },

  // Audio row
  audioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F0FDFA',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#CCFBF1',
  },
  audioLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0D9488',
    marginLeft: 6,
    flex: 1,
  },
  audioDuration: {
    fontSize: 11,
    color: '#64748B',
    fontVariant: ['tabular-nums'],
  },
  transcriptSnippet: {
    fontSize: 12,
    color: '#64748B',
    fontStyle: 'italic',
    lineHeight: 17,
    marginBottom: 8,
    paddingHorizontal: 4,
  },

  // Proforma
  proformaSection: {
    marginBottom: 8,
  },
  proformaSectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
    marginBottom: 4,
  },
  proformaQuestion: {
    fontSize: 12,
    color: '#475569',
    lineHeight: 18,
    paddingLeft: 4,
    marginBottom: 2,
  },

  // Differential diagnosis
  ddxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  ddxRank: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94A3B8',
    width: 28,
  },
  ddxName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E293B',
  },
  ddxProb: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 1,
  },
  mnmBadge: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    marginLeft: 8,
  },
  mnmText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#DC2626',
    letterSpacing: 0.5,
  },

  // Problem list
  problemRow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  problemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  problemName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E293B',
    flex: 1,
  },
  problemType: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  rxList: {
    marginTop: 4,
  },
  rxItem: {
    fontSize: 12,
    color: '#475569',
    lineHeight: 18,
  },
});

export default React.memo(HomePage);
