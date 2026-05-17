import React, {useState, useCallback, useRef, useEffect, useMemo} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  Alert,
  TextInput,
  ScrollView,
  Modal,
  Keyboard,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiService from '../services/apiService';
import {Audio} from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import useKeyboardCentering from '../hooks/useKeyboardCentering';

const CURRENT_PATIENT_KEY = '@nurseai_current_patient';
const GEMINI_RETRY_CACHE_KEY = '@nurseai_gemini_retry';
const GEMINI_RETRY_WINDOW_MS = 30 * 60 * 1000;
const GEMINI_RETRY_DELAY_MS = 60 * 1000;
const GEMINI_RETRY_MAX_ATTEMPTS = 3;

const PROFORMA_DIABETES = `1. Diagnosis Background
Ask the patient:
When were you first diagnosed with diabetes? Capture duration in years or months.
Do you know which type of diabetes you have — Type 1, Type 2, or gestational?
Have you ever been hospitalized because of diabetes? If yes, when and why?

2. Current Symptoms
Ask specifically and document response:
Are you urinating more frequently than usual?
Are you feeling excessive thirst?
Are you feeling increased hunger?
Have you had any recent weight change? If yes, record how many kilograms and over what time period.
Are you feeling fatigue?
Any blurred vision?
Any tingling or numbness in hands or feet?
Any wounds that are taking longer than usual to heal?
Any recurrent infections in the last 6 months?

3. Home Sugar Monitoring (Capture Exact Numbers)
Ask clearly:
Do you check your blood sugar at home?
What is your usual fasting blood sugar reading? Record in mg/dL.
What is your usual post-meal blood sugar reading? Record in mg/dL.
What was your most recent blood sugar reading? Record value and date.
When was your last HbA1c test?
What was the HbA1c percentage?
Low sugar screening:
Have you had episodes of low blood sugar?
What was the lowest value recorded?
How often do these episodes occur?
What symptoms do you get during low sugar?

4. Medication Details (Precise Dosing Required)
Ask in detail:
What diabetes medicines are you currently taking? Record exact drug names.
What is the dose of each medicine?
How many times per day do you take it?
If on insulin:
What type of insulin are you using?
How many units do you take in the morning?
How many units do you take in the afternoon?
How many units do you take at night?
Do you ever skip insulin doses?
Ask about adherence clearly:
How many doses do you miss per week on average?

5. Complication Screening
Kidney:
Have you had kidney tests recently?
What was your last serum creatinine value?
Have you ever been told you have protein in urine?
Eye:
When was your last eye examination?
Were you told you have diabetic retinopathy?
Nerve:
Do you have burning pain in feet?
Loss of sensation?
Any balance issues?
Heart:
Any chest pain?
Any shortness of breath on exertion?
Foot:
Any foot ulcers currently?
Any past amputations?

6. Vital and Clinical Measurements (To Measure Now)
The app should remind the nurse to capture:
Current weight in kilograms.
Height in centimeters.
Calculate BMI.
Blood pressure.
Pulse rate.
Respiratory rate.

7. Lab Values (If Available – Capture Exact Numbers)
Ask:
What was your last fasting blood sugar lab value?
What was your last post-prandial value?
What was your HbA1c?
What were your cholesterol values?
What was your serum creatinine?
Was urine albumin tested? What was the result?

8. Lifestyle Quantification
Ask in measurable terms:
How many minutes per day do you exercise?
How many days per week?
How many cigarettes per day?
How many alcoholic drinks per week?
How many hours of sleep per night?`;

const PROFORMA_HYPERTENSION = `1. Opening
Are you here for blood pressure follow-up or new symptoms?
Since when are you having these complaints?

2. Current Symptoms
Headache?
Dizziness?
Blurred vision?
Chest pain?
Palpitations?
Shortness of breath?
Swelling in legs?
Or no symptoms?
Has anything worsened recently?
Have you ever had very high BP requiring emergency visit?

3. Past Illness
Do you have diabetes?
Heart disease or previous heart attack?
Stroke?
Kidney disease?
Thyroid problems?
Any other illness?

4. Medicines
What BP medicines are you taking?
Do you take them regularly?
Any side effects?
Any other medicines including herbal?

5. Family History
Does anyone in your family have high blood pressure?
Family history of diabetes?
Stroke?
Heart attack?
Kidney disease?

6. Lifestyle
Do you smoke?
Do you drink alcohol?
How would you describe your diet? High salt? Normal? Low salt?
Do you exercise?
How stressed are you — low, moderate, high?

7. Organ Damage Screening
Any vision changes?
Chest pressure?
Breathlessness while lying flat?
Swelling in feet?
Less urine or frothy urine?
Episodes of weakness or difficulty speaking?

8. Monitoring
Do you check BP at home?
What was your last BP reading?`;

const PROFORMA_FEVER = `1. Opening
What brings you in today?
Since when have you had fever?
Have you measured your temperature? What was the highest reading?
Does the fever stay all day or come and go?
Is it higher in the evening?

2. Associated Symptoms
Do you get chills or shivering?
Body pain?
Feeling weak or unusually tired?
Headache?
Any confusion or fits?
Sore throat?
Cough?
Difficulty breathing?
Stomach pain?
Vomiting or nausea?
Loose motions?
Burning while passing urine?
Any skin rashes?
Joint pains?

3. Exposure & Travel
Has anyone around you had fever recently?
Any mosquito bites?
Contact with animals like cattle, dogs, or rodents?
Have you travelled in the last 4 weeks?
Any exposure to dirty water or flooding?

4. Medical Background
Have you had similar fever before?
Do you have diabetes?
High blood pressure?
Heart problems?
Asthma?
Thyroid issues?
Kidney disease?
HIV or low immunity?
Any recent dental procedure?
Have you had your spleen removed?

5. Medication History
Are you taking any regular medicines?
Have you taken antibiotics for this fever?
Have you taken paracetamol or ibuprofen?
Any herbal or traditional medicines?

6. Immunization & Other Important Points
Have you taken COVID vaccine?
Typhoid vaccine?
Any recent surgery?
(If female) When was your last menstrual period?
Are you able to drink fluids?
Is your urine output normal?

7. Red Flag Screening (Ask Directly)
Are you feeling extremely weak?
Any confusion?
Is your fever very high (above 103°F)?
Neck stiffness or light hurting your eyes?
Not passing urine?
Severe breathing difficulty?
Any bleeding`;

const PROFORMAS = [
  {id: 'diabetes', title: 'Diabetes', content: PROFORMA_DIABETES},
  {id: 'hypertension', title: 'Hypertension', content: PROFORMA_HYPERTENSION},
  {id: 'fever', title: 'Fever', content: PROFORMA_FEVER},
];

const RecordPage = ({navigation}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [patientName, setPatientName] = useState('');
  const [patientId, setPatientId] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [missingFormVisible, setMissingFormVisible] = useState(false);
  const [missingFormCompleted, setMissingFormCompleted] = useState(false);
  const [requiredMissingKeys, setRequiredMissingKeys] = useState([]);
  const [missingSuggestionId, setMissingSuggestionId] = useState(null);
  const [pendingGeminiRetry, setPendingGeminiRetry] = useState(null);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [proformaQuery, setProformaQuery] = useState('');
  const [createProformaQuery, setCreateProformaQuery] = useState('');
  const [isGeneratingProforma, setIsGeneratingProforma] = useState(false);
  const [generatedProforma, setGeneratedProforma] = useState(null);
  const [proformaModalVisible, setProformaModalVisible] = useState(false);
  const [selectedProforma, setSelectedProforma] = useState(null);
  const [consentModalVisible, setConsentModalVisible] = useState(false);
  const [existingPatientModalVisible, setExistingPatientModalVisible] = useState(false);
  const [existingPatientName, setExistingPatientName] = useState('');
  const [isCheckingPatient, setIsCheckingPatient] = useState(false);
  const [diagnosisText, setDiagnosisText] = useState('');
  const [currentAudioRecordId, setCurrentAudioRecordId] = useState(null);
  const [isAnswerRecording, setIsAnswerRecording] = useState(false);
  const [isSubmittingAnswers, setIsSubmittingAnswers] = useState(false);
  const [answerRecordingSeconds, setAnswerRecordingSeconds] = useState(0);
  const [firstSegmentUri, setFirstSegmentUri] = useState(null);
  const [isGeneratingAutoProforma, setIsGeneratingAutoProforma] = useState(false);
  const [autoProformaText, setAutoProformaText] = useState('');
  const [missingData, setMissingData] = useState({
    age: '',
    gender: '',
    occupation: '',
    spo2: '',
    bp: '',
    hr: '',
    rr: '',
    weight: '',
    height: '',
    bmi: '',
  });
  const recordingRef = useRef(null);
  const answerRecordingRef = useRef(null);
  const answerRecordingStartRef = useRef(null);
  const answerRecordingIntervalRef = useRef(null);
  const scrollViewRef = useRef(null);
  const modalScrollRef = useRef(null);
  const {onScroll: onMainScroll, handleFocus: handleMainFocus} =
    useKeyboardCentering(scrollViewRef);
  const {onScroll: onModalScroll, handleFocus: handleModalFocus} =
    useKeyboardCentering(modalScrollRef);
  const recordingStartRef = useRef(null);
  const recordingIntervalRef = useRef(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [photoOptionsVisible, setPhotoOptionsVisible] = useState(false);
  const [pendingAudioUri, setPendingAudioUri] = useState(null);

  const canStartRecording = patientName.trim().length > 0 && patientId.trim().length > 0;
  const proformaItems = useMemo(() => {
    const query = proformaQuery.trim().toLowerCase();
    const combined = generatedProforma ? [generatedProforma, ...PROFORMAS] : PROFORMAS;
    if (!query) return combined;
    return combined.filter((item) => item.title.toLowerCase().includes(query));
  }, [proformaQuery, generatedProforma]);
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboardHeight(event.endCoordinates?.height || 0);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    const loadPendingRetry = async () => {
      try {
        const cached = await AsyncStorage.getItem(GEMINI_RETRY_CACHE_KEY);
        if (!cached) return;
        const parsed = JSON.parse(cached);
        if (!parsed?.expiresAt || Date.now() > parsed.expiresAt) {
          await AsyncStorage.removeItem(GEMINI_RETRY_CACHE_KEY);
          return;
        }
        setPendingGeminiRetry(parsed);
      } catch (error) {
        console.error('Failed to load retry cache:', error);
      }
    };
    loadPendingRetry();
  }, []);

  useEffect(() => {
    if (!pendingGeminiRetry) {
      setRetryCountdown(0);
      return;
    }
    const updateCountdown = () => {
      const remainingMs = Math.max(0, pendingGeminiRetry.nextRetryAt - Date.now());
      setRetryCountdown(Math.ceil(remainingMs / 1000));
    };
    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [pendingGeminiRetry]);

  const persistRetryState = useCallback(async (nextState) => {
    if (!nextState) {
      setPendingGeminiRetry(null);
      await AsyncStorage.removeItem(GEMINI_RETRY_CACHE_KEY);
      return;
    }
    setPendingGeminiRetry(nextState);
    await AsyncStorage.setItem(GEMINI_RETRY_CACHE_KEY, JSON.stringify(nextState));
  }, []);

  const handleGeminiRateLimit = useCallback(
    async (audioRecordId, retryAfterSeconds = 60, attempts = 0) => {
      const nextRetryAt = Date.now() + retryAfterSeconds * 1000;
      const expiresAt = Date.now() + GEMINI_RETRY_WINDOW_MS;
      await persistRetryState({
        audioRecordId,
        patientName: patientName.trim(),
        patientId: patientId.trim(),
        attempts,
        nextRetryAt,
        expiresAt,
      });
      Alert.alert(
        'Busy Right Now',
        'Your recording could not be sent due to too many concurrent users. Please try again in 60 seconds.'
      );
    },
    [patientId, patientName, persistRetryState]
  );

  const startRecording = useCallback(async () => {
    if (!canStartRecording) {
      Alert.alert('Required Fields', 'Please enter both Patient Name and Patient ID before recording.');
      return;
    }
    
    // Store current patient info for filtering in HomePage and HistoryPage
    const patientInfo = {
      patientName: patientName.trim(),
      patientId: patientId.trim(),
    };
    await AsyncStorage.setItem(CURRENT_PATIENT_KEY, JSON.stringify(patientInfo));
    
    try {
      if (recordingRef.current) {
        await recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }

      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission Required', 'Microphone permission is needed to record audio.');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
        staysActiveInBackground: false,
      });

      const {recording} = await Audio.Recording.createAsync(
        {
          android: {
            extension: '.m4a',
            outputFormat: Audio.AndroidOutputFormat.MPEG_4,
            audioEncoder: Audio.AndroidAudioEncoder.AAC,
            sampleRate: 22050,
            numberOfChannels: 1,
            bitRate: 64000,
          },
          ios: {
            extension: '.m4a',
            outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
            audioQuality: Audio.IOSAudioQuality.MEDIUM,
            sampleRate: 22050,
            numberOfChannels: 1,
            bitRate: 64000,
          },
          web: {
            mimeType: 'audio/webm',
            bitsPerSecond: 64000,
          },
        }
      );
      recordingRef.current = recording;
      recordingStartRef.current = Date.now();
      setRecordingSeconds(0);
      setIsRecording(true);
    } catch (error) {
      console.error('Error starting recording:', error);
      const message = String(error?.message || '');
      const isSessionError = message.toLowerCase().includes('session activation failed');
      Alert.alert(
        'Error',
        isSessionError
          ? 'Recording session failed to activate. Close other apps using the microphone and try again. If you are on iOS Simulator, use a physical device.'
          : 'Failed to start recording. Please try again.'
      );
    }
  }, [canStartRecording, patientName, patientId]);

  const handleStartRecording = useCallback(async () => {
    if (!canStartRecording) {
      Alert.alert('Required Fields', 'Please enter both Patient Name and Patient ID before recording.');
      return;
    }
    
    setIsCheckingPatient(true);
    try {
      const response = await apiService.checkPatientExists(patientId.trim());
      if (response.success && response.data.exists) {
        setExistingPatientName(response.data.patientName);
        setExistingPatientModalVisible(true);
      } else {
        setConsentModalVisible(true);
      }
    } catch (error) {
       console.error('Error checking patient:', error);
       setConsentModalVisible(true);
    } finally {
      setIsCheckingPatient(false);
    }
  }, [canStartRecording, patientId]);

  const handleProceedWithExisting = useCallback(() => {
    setExistingPatientModalVisible(false);
    if (existingPatientName) {
      setPatientName(existingPatientName);
    }
    setConsentModalVisible(true);
  }, [existingPatientName]);

  const handleEditId = useCallback(() => {
    setExistingPatientModalVisible(false);
    setPatientId('');
  }, []);

  const handleConsentAgree = useCallback(async () => {
    setConsentModalVisible(false);
    await startRecording();
  }, [startRecording]);

  const handleConsentCancel = useCallback(() => {
    setConsentModalVisible(false);
  }, []);

  const handleGenerateAutoProforma = useCallback(async () => {
    try {
      const recording = recordingRef.current;
      if (!recording) return;

      const status = await recording.getStatusAsync();
      if (!status.isRecording && !status.isDoneRecording) return;

      await recording.stopAndUnloadAsync();
      const segmentUri = recording.getURI();
      recordingRef.current = null;

      if (!segmentUri) {
        Alert.alert('Error', 'Failed to capture audio segment.');
        return;
      }

      setFirstSegmentUri(segmentUri);
      setIsGeneratingAutoProforma(true);

      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission Required', 'Microphone permission is needed to continue recording.');
        setIsGeneratingAutoProforma(false);
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
        staysActiveInBackground: false,
      });

      const {recording: newRecording} = await Audio.Recording.createAsync({
        android: {
          extension: '.m4a',
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 22050,
          numberOfChannels: 1,
          bitRate: 64000,
        },
        ios: {
          extension: '.m4a',
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.MEDIUM,
          sampleRate: 22050,
          numberOfChannels: 1,
          bitRate: 64000,
        },
        web: {mimeType: 'audio/webm', bitsPerSecond: 64000},
      });
      recordingRef.current = newRecording;
      recordingStartRef.current = Date.now();

      apiService.extractProforma(segmentUri, patientId.trim()).then((result) => {
        setIsGeneratingAutoProforma(false);
        if (result.success) {
          const proforma = result.data?.data?.proformaText || result.data?.proformaText || '';
          setAutoProformaText(proforma);
        } else {
          console.error('Auto proforma failed:', result.error);
          Alert.alert('Proforma Error', result.error || 'Failed to generate proforma from recording.');
        }
      }).catch((err) => {
        setIsGeneratingAutoProforma(false);
        console.error('Auto proforma error:', err);
      });
    } catch (error) {
      console.error('Error generating auto proforma:', error);
      setIsGeneratingAutoProforma(false);
      Alert.alert('Error', 'Failed to generate proforma. Recording continues.');
    }
  }, [patientId]);

  const parseMissingFields = useCallback((content) => {
    if (!content) return [];
    const lower = content.toLowerCase();
    const sectionIndex = lower.indexOf('8. missing data');
    if (sectionIndex === -1) return [];

    const after = content.slice(sectionIndex);
    const sectionBody = after.split(/tone:/i)[0] || after;
    const tokens = sectionBody
      .replace(/\r/g, '')
      .split(/[\n,\/]/g)
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean);

    const matches = new Set();
    const addIfMatch = (token, key) => {
      if (token.includes(key)) {
        matches.add(key);
      }
    };

    tokens.forEach((token) => {
      if (token.includes('spo2') || token.includes('sp02')) matches.add('spo2');
      if (token.includes('bp') || token.includes('blood pressure')) matches.add('bp');
      if (token.includes('hr') || token.includes('heart rate')) matches.add('hr');
      if (token.includes('rr') || token.includes('respiratory rate')) matches.add('rr');
      if (token.includes('weight')) matches.add('weight');
      if (token.includes('height')) matches.add('height');
      if (token.includes('bmi')) matches.add('bmi');
      if (token.includes('age')) matches.add('age');
      if (token.includes('gender') || token.includes('sex')) matches.add('gender');
      addIfMatch(token, 'occupation');
    });

    return Array.from(matches);
  }, []);

  const handleMissingDataFlow = useCallback(async () => {
    const geminiResult = await apiService.getLatestGeminiSuggestion({
      patientName: patientName.trim(),
      patientId: patientId.trim(),
    });
    if (!geminiResult.success) {
      setRequiredMissingKeys([]);
      setMissingSuggestionId(null);
      Alert.alert('Success', 'Recording uploaded successfully.');
      return;
    }

    const latest = geminiResult.data;
    const missingKeys = parseMissingFields(latest?.content || '');

    if (missingKeys.length === 0) {
      setRequiredMissingKeys([]);
      setMissingSuggestionId(null);
      Alert.alert('Success', 'Recording uploaded successfully.');
      return;
    }

    setRequiredMissingKeys(missingKeys);
    setMissingSuggestionId(latest?.id || null);
    setMissingFormVisible(true);
    setMissingFormCompleted(false);
  }, [parseMissingFields, patientId, patientName]);

  const uploadRecording = useCallback(
    async (audioUri, photoUri) => {
      setIsUploading(true);
      try {
        const uploadParams = {
          photoUri,
          patientName: patientName.trim(),
          patientId: patientId.trim(),
        };

        if (firstSegmentUri) {
          uploadParams.uri = firstSegmentUri;
          uploadParams.secondAudioUri = audioUri;
        } else {
          uploadParams.uri = audioUri;
        }

        const uploadResult = await apiService.uploadAudio(uploadParams);

        if (uploadResult.success) {
          const payload = uploadResult.data?.data || {};
          const geminiGenerated = payload.geminiGenerated;
          const geminiError = payload.geminiError;
          const geminiErrorCode = payload.geminiErrorCode;
          const retryAfterSeconds = payload.geminiRetryAfterSeconds || 60;
          if (geminiGenerated === false) {
            if (geminiErrorCode === 'RATE_LIMIT' && payload.id) {
              await handleGeminiRateLimit(payload.id, retryAfterSeconds, 0);
              return;
            }
            Alert.alert(
              'Uploaded',
              geminiError || 'Recording uploaded, but no Gemini suggestion was generated.'
            );
            return;
          }
          setCurrentAudioRecordId(payload.id);
          setDiagnosisText(payload.diagnosisText || '');
          setFirstSegmentUri(null);
          setAutoProformaText('');
        } else {
          Alert.alert('Upload Failed', uploadResult.error || 'Failed to upload recording.');
        }
      } catch (error) {
        console.error('Upload error:', error);
        Alert.alert('Error', 'Failed to upload recording. Please try again.');
      } finally {
        setIsUploading(false);
      }
    },
    [patientName, patientId, handleGeminiRateLimit, firstSegmentUri]
  );

  const startAnswerRecording = useCallback(async () => {
    try {
      if (answerRecordingRef.current) {
        await answerRecordingRef.current.stopAndUnloadAsync().catch(() => {});
        answerRecordingRef.current = null;
      }

      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission Required', 'Microphone permission is needed to record audio.');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
        staysActiveInBackground: false,
      });

      const {recording} = await Audio.Recording.createAsync({
        android: {
          extension: '.m4a',
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 22050,
          numberOfChannels: 1,
          bitRate: 64000,
        },
        ios: {
          extension: '.m4a',
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.MEDIUM,
          sampleRate: 22050,
          numberOfChannels: 1,
          bitRate: 64000,
        },
        web: {
          mimeType: 'audio/webm',
          bitsPerSecond: 64000,
        },
      });
      answerRecordingRef.current = recording;
      answerRecordingStartRef.current = Date.now();
      setAnswerRecordingSeconds(0);
      setIsAnswerRecording(true);
    } catch (error) {
      console.error('Error starting answer recording:', error);
      Alert.alert('Error', 'Failed to start recording. Please try again.');
    }
  }, []);

  const stopAnswerAndSubmit = useCallback(async () => {
    try {
      setIsAnswerRecording(false);

      const recording = answerRecordingRef.current;
      if (!recording) {
        Alert.alert('Error', 'No active answer recording found.');
        return;
      }

      const status = await recording.getStatusAsync();
      if (!status.isDoneRecording && status.isRecording) {
        await recording.stopAndUnloadAsync();
      } else {
        await recording.stopAndUnloadAsync().catch(() => {});
      }

      const uri = recording.getURI();
      answerRecordingRef.current = null;

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      if (!uri) {
        Alert.alert('Error', 'Answer recording failed. No audio file was created.');
        return;
      }

      const durationMs = status.durationMillis || 0;
      if (durationMs < 500) {
        Alert.alert('Recording Too Short', 'The answer recording appears to be empty. Please try again.');
        return;
      }

      setIsSubmittingAnswers(true);
      try {
        const result = await apiService.submitClarifyingAnswers(currentAudioRecordId, uri);
        if (result.success) {
          setDiagnosisText('');
          setCurrentAudioRecordId(null);
          await handleMissingDataFlow();
        } else {
          Alert.alert(
            'Error',
            result.error || 'Failed to generate prescription. Please try again.'
          );
        }
      } catch (error) {
        console.error('Submit answer audio error:', error);
        Alert.alert('Error', 'Failed to submit answers. Please try again.');
      } finally {
        setIsSubmittingAnswers(false);
      }
    } catch (error) {
      console.error('Error stopping answer recording:', error);
      Alert.alert('Error', 'Failed to stop answer recording. Please try again.');
    }
  }, [currentAudioRecordId, handleMissingDataFlow]);

  const handleRetryGemini = useCallback(async () => {
    if (!pendingGeminiRetry) {
      return;
    }
    if (Date.now() < pendingGeminiRetry.nextRetryAt) {
      Alert.alert(
        'Please wait',
        `Try again in ${retryCountdown || 60} seconds.`
      );
      return;
    }
    if (pendingGeminiRetry.attempts >= GEMINI_RETRY_MAX_ATTEMPTS) {
      await persistRetryState(null);
      Alert.alert('Please try again later', 'Retry limit reached. Please try again later.');
      return;
    }
    setIsUploading(true);
    try {
      const result = await apiService.retryGeminiForAudio(
        pendingGeminiRetry.audioRecordId
      );
      if (result.success) {
        const payload = result.data || {};
        if (payload.geminiGenerated) {
          await persistRetryState(null);
          await handleMissingDataFlow();
          return;
        }
        if (payload.geminiErrorCode === 'RATE_LIMIT') {
          const nextAttempts = pendingGeminiRetry.attempts + 1;
          if (nextAttempts >= GEMINI_RETRY_MAX_ATTEMPTS) {
            await persistRetryState(null);
            Alert.alert(
              'Please try again later',
              'Retry limit reached. Please try again later.'
            );
            return;
          }
          await handleGeminiRateLimit(
            pendingGeminiRetry.audioRecordId,
            payload.geminiRetryAfterSeconds || 60,
            nextAttempts
          );
          return;
        }
        Alert.alert(
          'Gemini Error',
          payload.geminiError || 'Gemini processing failed.'
        );
        await persistRetryState(null);
        return;
      }
      Alert.alert('Retry Failed', result.error || 'Failed to retry Gemini.');
    } catch (error) {
      console.error('Retry Gemini error:', error);
      Alert.alert('Error', 'Failed to retry Gemini.');
    } finally {
      setIsUploading(false);
    }
  }, [
    pendingGeminiRetry,
    retryCountdown,
    handleMissingDataFlow,
    handleGeminiRateLimit,
    persistRetryState,
  ]);

  const pickPhotoFromLibrary = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission Required', 'Allow photo access to attach a photo.');
      return null;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
    });

    if (result.canceled) {
      return null;
    }

    return result.assets?.[0]?.uri || null;
  }, []);

  const pickPhotoFromCamera = useCallback(async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission Required', 'Allow camera access to take a photo.');
      return null;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
    });

    if (result.canceled) {
      return null;
    }

    return result.assets?.[0]?.uri || null;
  }, []);

  const promptPhotoUpload = useCallback((audioUri) => {
    setPendingAudioUri(audioUri);
    setPhotoOptionsVisible(true);
  }, []);

  const handleDiscardRecording = useCallback(() => {
    setPhotoOptionsVisible(false);
    setPendingAudioUri(null);
  }, []);

  const handleUploadWithoutPhoto = useCallback(() => {
    const audioUri = pendingAudioUri;
    setPhotoOptionsVisible(false);
    setPendingAudioUri(null);
    if (audioUri) {
      uploadRecording(audioUri, null);
    }
  }, [pendingAudioUri, uploadRecording]);

  const handleChooseFromLibrary = useCallback(async () => {
    const audioUri = pendingAudioUri;
    if (!audioUri) return;
    setPhotoOptionsVisible(false);
    const photoUri = await pickPhotoFromLibrary();
    if (!photoUri) {
      setPhotoOptionsVisible(true);
      return;
    }
    setPendingAudioUri(null);
    uploadRecording(audioUri, photoUri);
  }, [pendingAudioUri, pickPhotoFromLibrary, uploadRecording]);

  const handleTakePhoto = useCallback(async () => {
    const audioUri = pendingAudioUri;
    if (!audioUri) return;
    setPhotoOptionsVisible(false);
    const photoUri = await pickPhotoFromCamera();
    if (!photoUri) {
      setPhotoOptionsVisible(true);
      return;
    }
    setPendingAudioUri(null);
    uploadRecording(audioUri, photoUri);
  }, [pendingAudioUri, pickPhotoFromCamera, uploadRecording]);

  const handleStopRecording = useCallback(async () => {
    try {
      setIsRecording(false);

      const recording = recordingRef.current;
      if (!recording) {
        Alert.alert('Error', 'No active recording found.');
        return;
      }

      const status = await recording.getStatusAsync();
      console.log('Recording status before stop:', JSON.stringify(status));

      if (!status.isDoneRecording && status.isRecording) {
        await recording.stopAndUnloadAsync();
      } else {
        await recording.stopAndUnloadAsync().catch(() => {});
      }

      const uri = recording.getURI();
      recordingRef.current = null;

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      if (!uri) {
        Alert.alert('Error', 'Recording failed. No audio file was created.');
        return;
      }

      const durationMs = status.durationMillis || 0;
      if (durationMs < 500) {
        Alert.alert('Recording Too Short', 'The recording appears to be empty. Please try again.');
        return;
      }

      console.log(`Recording stopped: duration=${durationMs}ms, uri=${uri}`);
      promptPhotoUpload(uri);
    } catch (error) {
      console.error('Error stopping recording:', error);
      Alert.alert('Error', 'Failed to stop recording. Please try again.');
    }
  }, [promptPhotoUpload]);

  useEffect(() => {
    if (!isRecording) {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }
      return;
    }

    recordingIntervalRef.current = setInterval(() => {
      if (!recordingStartRef.current) return;
      const elapsed = Math.floor((Date.now() - recordingStartRef.current) / 1000);
      setRecordingSeconds(elapsed);
    }, 500);

    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }
    };
  }, [isRecording]);

  useEffect(() => {
    if (!isAnswerRecording) {
      if (answerRecordingIntervalRef.current) {
        clearInterval(answerRecordingIntervalRef.current);
        answerRecordingIntervalRef.current = null;
      }
      return;
    }

    answerRecordingIntervalRef.current = setInterval(() => {
      if (!answerRecordingStartRef.current) return;
      const elapsed = Math.floor((Date.now() - answerRecordingStartRef.current) / 1000);
      setAnswerRecordingSeconds(elapsed);
    }, 500);

    return () => {
      if (answerRecordingIntervalRef.current) {
        clearInterval(answerRecordingIntervalRef.current);
        answerRecordingIntervalRef.current = null;
      }
    };
  }, [isAnswerRecording]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      if (diagnosisText && currentAudioRecordId) {
        e.preventDefault();
        Alert.alert(
          'Diagnosis In Progress',
          'Please record and submit your answers to the clarifying questions before leaving.'
        );
        return;
      }
      if (missingFormVisible && !missingFormCompleted) {
        e.preventDefault();
        Alert.alert(
          'Missing Patient Data',
          'Please complete the missing patient data form before leaving.'
        );
      }
    });

    return () => {
      unsubscribe();
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }
      if (answerRecordingRef.current) {
        answerRecordingRef.current.stopAndUnloadAsync().catch(() => {});
        answerRecordingRef.current = null;
      }
      if (answerRecordingIntervalRef.current) {
        clearInterval(answerRecordingIntervalRef.current);
        answerRecordingIntervalRef.current = null;
      }
    };
  }, [navigation, missingFormVisible, missingFormCompleted, diagnosisText, currentAudioRecordId]);

  const formatDuration = useCallback((totalSeconds) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }, []);

  const isMissingFormValid = requiredMissingKeys.every(
    (key) => missingData[key]?.trim().length > 0
  );

  const updateMissingData = useCallback((key, value) => {
    setMissingData((prev) => ({...prev, [key]: value}));
  }, []);

  const handleSubmitMissingData = useCallback(() => {
    if (!isMissingFormValid) {
      Alert.alert('Required Fields', 'Please fill all missing patient data.');
      return;
    }
    const payload = requiredMissingKeys.reduce((acc, key) => {
      acc[key] = missingData[key];
      return acc;
    }, {});

    const followupMessage = [
      'Updated patient demographics and vitals:',
      ...Object.entries(payload).map(([key, value]) => {
        const labelMap = {
          age: 'Age',
          gender: 'Gender',
          occupation: 'Occupation',
          spo2: 'SpO2',
          bp: 'BP',
          hr: 'HR',
          rr: 'RR',
          weight: 'Weight',
          height: 'Height',
          bmi: 'BMI',
        };
        return `${labelMap[key] || key}: ${String(value).trim()}`;
      }),
    ].join('\n');

    const updateRequest = missingSuggestionId
      ? apiService.followupGeminiSuggestion(
          missingSuggestionId,
          followupMessage,
          patientId.trim()
        )
      : Promise.resolve({success: true});

    updateRequest.then((result) => {
      if (!result.success) {
        Alert.alert('Update Failed', result.error || 'Failed to update missing data.');
        return;
      }
      setMissingFormCompleted(true);
      setMissingFormVisible(false);
    });
  }, [isMissingFormValid, missingSuggestionId, missingData, requiredMissingKeys]);

  const handleGenerateProforma = useCallback(async () => {
    const symptoms = createProformaQuery.trim();
    if (!symptoms) {
      Alert.alert('Required', 'Please enter symptoms to generate a proforma.');
      return;
    }

    try {
      setIsGeneratingProforma(true);
      const result = await apiService.generateProforma(symptoms);
      if (result.success && result.data?.content) {
        const titleBase = symptoms.length > 48 ? `${symptoms.slice(0, 45)}...` : symptoms;
        setGeneratedProforma({
          id: `ai-${Date.now()}`,
          title: `AI Proforma: ${titleBase}`,
          content: result.data.content,
        });
        setCreateProformaQuery('');
      } else {
        Alert.alert('Error', result.error || 'Failed to generate proforma.');
      }
    } catch (error) {
      console.error('Generate proforma error:', error);
      Alert.alert('Error', 'Failed to generate proforma. Please try again.');
    } finally {
      setIsGeneratingProforma(false);
    }
  }, [createProformaQuery]);

  const handleOpenProforma = useCallback((proforma) => {
    setSelectedProforma(proforma);
    setProformaModalVisible(true);
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        onScroll={onMainScroll}
        scrollEventThrottle={16}>
        <View style={styles.contentInner}>
          <View style={styles.proformaSection}>
            <Text style={styles.sectionTitle}>Search Proforma</Text>
            <View style={styles.proformaSearchWrapper}>
              <Ionicons name="search-outline" size={18} color="#94A3B8" />
              <TextInput
                style={styles.proformaSearchInput}
                placeholder="Search proforma"
                placeholderTextColor="#94A3B8"
                value={proformaQuery}
                onChangeText={setProformaQuery}
                onFocus={handleMainFocus}
              />
            </View>
            <View style={styles.proformaCreateWrapper}>
              <Ionicons name="sparkles-outline" size={18} color="#94A3B8" />
              <TextInput
                style={styles.proformaCreateInput}
                placeholder="Create proforma (e.g., rash and fever)"
                placeholderTextColor="#94A3B8"
                value={createProformaQuery}
                onChangeText={setCreateProformaQuery}
                onFocus={handleMainFocus}
              />
              <TouchableOpacity
                style={[
                  styles.proformaCreateButton,
                  (!createProformaQuery.trim() || isGeneratingProforma) &&
                    styles.proformaCreateButtonDisabled,
                ]}
                onPress={handleGenerateProforma}
                disabled={!createProformaQuery.trim() || isGeneratingProforma}>
                <Text style={styles.proformaCreateButtonText}>
                  {isGeneratingProforma ? 'Creating...' : 'Create'}
                </Text>
              </TouchableOpacity>
            </View>
            <View style={styles.proformaList}>
              {proformaItems.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={styles.proformaItem}
                  onPress={() => handleOpenProforma(item)}
                  activeOpacity={0.8}>
                  <Text style={styles.proformaItemText}>{item.title}</Text>
                  <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
                </TouchableOpacity>
              ))}
              {proformaItems.length === 0 && (
                <View style={styles.proformaEmpty}>
                  <Text style={styles.proformaEmptyText}>No proformas found.</Text>
                </View>
              )}
            </View>
          </View>

          {(autoProformaText || isGeneratingAutoProforma) ? (
            <View style={styles.autoProformaSection}>
              <View style={styles.diagnosisSectionHeader}>
                <Ionicons name="document-text" size={20} color="#059669" />
                <Text style={[styles.diagnosisSectionTitle, {color: '#059669'}]}>Auto-Generated Proforma</Text>
              </View>
              {isGeneratingAutoProforma ? (
                <View style={styles.answerSubmittingContainer}>
                  <ActivityIndicator size="small" color="#059669" />
                  <Text style={[styles.answerSubmittingText, {color: '#059669'}]}>Generating proforma from recording...</Text>
                </View>
              ) : (
                <View style={styles.diagnosisCard}>
                  <Text style={styles.diagnosisContent}>{autoProformaText}</Text>
                </View>
              )}
            </View>
          ) : null}

          {diagnosisText ? (
            <View style={styles.diagnosisSection}>
              <View style={styles.diagnosisSectionHeader}>
                <Ionicons name="medkit" size={20} color="#0D9488" />
                <Text style={styles.diagnosisSectionTitle}>Diagnostic Assessment</Text>
              </View>
              <Text style={styles.diagnosisSectionSubtitle}>
                Review the assessment below, then tap "Answer" to record your responses to the clarifying questions.
              </Text>
              <View style={styles.diagnosisCard}>
                <Text style={styles.diagnosisContent}>{diagnosisText}</Text>
              </View>
              {isAnswerRecording ? (
                <View style={styles.answerRecordingContainer}>
                  <View style={styles.answerRecordingIndicator}>
                    <Ionicons name="mic" size={24} color="#DC2626" />
                    <Text style={styles.answerRecordingTimer}>{formatDuration(answerRecordingSeconds)}</Text>
                    <Text style={styles.answerRecordingLabel}>Recording answers...</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.answerStopButton}
                    onPress={stopAnswerAndSubmit}
                    activeOpacity={0.8}>
                    <Ionicons name="stop" size={20} color="#FFFFFF" />
                    <Text style={styles.answerStopButtonText}>Stop & Submit</Text>
                  </TouchableOpacity>
                </View>
              ) : isSubmittingAnswers ? (
                <View style={styles.answerSubmittingContainer}>
                  <ActivityIndicator size="small" color="#0D9488" />
                  <Text style={styles.answerSubmittingText}>Generating prescription...</Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.answerButton}
                  onPress={startAnswerRecording}
                  activeOpacity={0.8}>
                  <Ionicons name="mic-outline" size={20} color="#FFFFFF" />
                  <Text style={styles.answerButtonText}>Answer</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : null}

          <View style={styles.iconContainer}>
            <Ionicons 
              name={isRecording ? 'mic' : 'mic-outline'} 
              size={80} 
              color={isRecording ? '#DC2626' : '#0D9488'} 
            />
          </View>
        
        <Text style={styles.title}>
          {isRecording ? 'Recording...' : 'Ready to Record'}
        </Text>
        <Text style={styles.subtitle}>
          {isRecording 
            ? 'Tap stop when finished' 
            : 'Enter patient details below to start recording'}
        </Text>

        {/* Patient Information Form */}
        {!isRecording && (
          <View style={styles.formContainer}>
            <View style={styles.inputContainer}>
              <Text style={styles.label}>Patient Name *</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="person-outline" size={20} color="#94A3B8" style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter patient name"
                  placeholderTextColor="#94A3B8"
                  value={patientName}
                  onChangeText={setPatientName}
                  onFocus={handleMainFocus}
                  editable={!isRecording}
                />
              </View>
            </View>

            <View style={styles.inputContainer}>
              <Text style={styles.label}>Patient ID *</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="id-card-outline" size={20} color="#94A3B8" style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter patient ID"
                  placeholderTextColor="#94A3B8"
                  value={patientId}
                  onChangeText={setPatientId}
                  onFocus={handleMainFocus}
                  editable={!isRecording}
                />
              </View>
            </View>
          </View>
        )}

        {/* Display patient info during recording */}
        {isRecording && (
          <View style={styles.patientInfoContainer}>
            <View style={styles.patientInfoRow}>
              <Ionicons name="person" size={16} color="#64748B" />
              <Text style={styles.patientInfoText}>{patientName}</Text>
            </View>
            <View style={styles.patientInfoRow}>
              <Ionicons name="id-card" size={16} color="#64748B" />
              <Text style={styles.patientInfoText}>ID: {patientId}</Text>
            </View>
            <View style={styles.timerRow}>
              <Ionicons name="time-outline" size={16} color="#DC2626" />
              <Text style={styles.timerText}>{formatDuration(recordingSeconds)}</Text>
            </View>
          </View>
        )}

          {/* When recording with proforma available, show side-by-side */}
          {isRecording && recordingSeconds >= 30 && !firstSegmentUri ? (
            <View style={styles.recordButtonRow}>
              <TouchableOpacity
                style={[
                  styles.recordButton,
                  styles.recordButtonActive,
                  styles.recordButtonInRow,
                  isUploading ? styles.recordButtonDisabled : null
                ]}
                onPress={handleStopRecording}
                activeOpacity={0.8}
                disabled={isUploading}>
                <Ionicons name="stop" size={28} color="#FFFFFF" />
                <Text style={styles.recordButtonText}>
                  {isUploading ? 'Uploading...' : 'Stop'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.autoProformaButton,
                  styles.autoProformaButtonInRow,
                  isGeneratingAutoProforma && styles.recordButtonDisabled,
                ]}
                onPress={handleGenerateAutoProforma}
                activeOpacity={0.8}
                disabled={isGeneratingAutoProforma}>
                <Ionicons name="document-text-outline" size={20} color="#FFFFFF" />
                <Text style={styles.autoProformaButtonText}>
                  {isGeneratingAutoProforma ? 'Generating...' : 'Proforma'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={[
                styles.recordButton, 
                isRecording && styles.recordButtonActive,
                (!canStartRecording && !isRecording) || isUploading || (diagnosisText && currentAudioRecordId) ? styles.recordButtonDisabled : null
              ]}
              onPress={isRecording ? handleStopRecording : handleStartRecording}
              activeOpacity={0.8}
              disabled={(!canStartRecording && !isRecording) || isUploading || Boolean(diagnosisText && currentAudioRecordId)}>
              <Ionicons 
                name={isRecording ? 'stop' : 'mic'} 
                size={32} 
                color="#FFFFFF" 
              />
              <Text style={styles.recordButtonText}>
                {isUploading ? 'Uploading...' : isRecording ? 'Stop Recording' : 'Start Recording'}
              </Text>
            </TouchableOpacity>
          )}
          {pendingGeminiRetry && (
            <View style={styles.retryCard}>
              <Text style={styles.retryTitle}>Gemini is busy</Text>
              <Text style={styles.retrySubtitle}>
                {retryCountdown > 0
                  ? `Retry available in ${retryCountdown}s`
                  : 'You can retry now.'}
              </Text>
              <TouchableOpacity
                style={[
                  styles.retryButton,
                  (retryCountdown > 0 || isUploading) && styles.retryButtonDisabled,
                ]}
                onPress={handleRetryGemini}
                disabled={retryCountdown > 0 || isUploading}>
                <Text style={styles.retryButtonText}>
                  {isUploading ? 'Retrying...' : 'Retry Gemini'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
          <View style={{height: keyboardHeight}} />
        </View>
      </ScrollView>

      <Modal
        visible={consentModalVisible}
        transparent
        animationType="fade"
        onRequestClose={handleConsentCancel}>
        <View style={styles.consentModalOverlay}>
          <View style={styles.consentModalCard}>
            <Text style={styles.consentModalTitle}>Informed Consent</Text>
            <Text style={styles.consentModalBody}>
              Note: please inform the patient that NurseAI is right now only collecting data for
              research purposes and the organisation will try its best to protect the data yet in
              case of leaks/hacking the organisation is not liable.
            </Text>
            <View style={styles.consentModalActions}>
              <Pressable style={styles.consentModalCancel} onPress={handleConsentCancel}>
                <Text style={styles.consentModalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.consentModalAgree} onPress={handleConsentAgree}>
                <Text style={styles.consentModalAgreeText}>Agree & Start</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={existingPatientModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setExistingPatientModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.consentCard}>
            <View style={styles.consentHeaderRow}>
              <View style={styles.consentIcon}>
                <Ionicons name="person-circle" size={24} color="#0EA5E9" />
              </View>
              <Text style={styles.consentTitle}>Existing Patient Found</Text>
            </View>
            <Text style={styles.consentText}>
              This Patient ID is already registered to <Text style={{fontWeight: '700', color: '#1E293B'}}>{existingPatientName}</Text>.
              {'\n\n'}Do you want to edit the ID for a new patient or proceed with recording for {existingPatientName}?
            </Text>
            <View style={styles.consentActions}>
              <TouchableOpacity
                style={[styles.consentButton, styles.consentButtonSecondary]}
                onPress={handleEditId}>
                <Text style={styles.consentButtonSecondaryText}>Edit ID</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.consentButton, styles.consentButtonPrimary]}
                onPress={handleProceedWithExisting}>
                <Text style={styles.consentButtonPrimaryText}>Proceed</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={photoOptionsVisible}
        transparent
        animationType="fade"
        onRequestClose={handleDiscardRecording}>
        <View style={styles.modalOverlay}>
          <View style={styles.photoModalCard}>
            <Text style={styles.modalTitle}>Attach Photo?</Text>
            <Text style={styles.modalSubtitle}>
              You can add a patient photo before uploading. This is optional.
            </Text>
            <TouchableOpacity
              style={[
                styles.photoOptionButton,
                styles.photoOptionPrimary,
                isUploading && styles.photoOptionDisabled,
              ]}
              onPress={handleUploadWithoutPhoto}
              disabled={isUploading}>
              <Text style={[styles.photoOptionText, styles.photoOptionPrimaryText]}>
                Upload Without Photo
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.photoOptionButton,
                isUploading && styles.photoOptionDisabled,
              ]}
              onPress={handleChooseFromLibrary}
              disabled={isUploading}>
              <Text style={styles.photoOptionText}>Choose from Library</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.photoOptionButton,
                isUploading && styles.photoOptionDisabled,
              ]}
              onPress={handleTakePhoto}
              disabled={isUploading}>
              <Text style={styles.photoOptionText}>Take Photo</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.photoOptionButton,
                styles.photoOptionDestructive,
                isUploading && styles.photoOptionDisabled,
              ]}
              onPress={handleDiscardRecording}
              disabled={isUploading}>
              <Text style={[styles.photoOptionText, styles.photoOptionDestructiveText]}>
                Don’t Upload
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={missingFormVisible}
        transparent
        animationType="slide"
        onRequestClose={() => {}}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Missing Patient Data</Text>
            <Text style={styles.modalSubtitle}>
              Recording submitted. Please fill all missing demographics and vitals.
            </Text>
            <ScrollView
              ref={modalScrollRef}
              style={styles.modalForm}
              keyboardShouldPersistTaps="handled"
              onScroll={onModalScroll}
              scrollEventThrottle={16}>
              <View>
              <Text style={styles.modalSectionTitle}>Demographics</Text>
              {requiredMissingKeys.includes('age') && (
                <View style={styles.modalField}>
                  <Text style={styles.modalLabel}>Age *</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={missingData.age}
                    onChangeText={(value) => updateMissingData('age', value)}
                    onFocus={handleModalFocus}
                    placeholder="Age"
                    keyboardType="number-pad"
                  />
                </View>
              )}
              {requiredMissingKeys.includes('gender') && (
                <View style={styles.modalField}>
                  <Text style={styles.modalLabel}>Gender *</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={missingData.gender}
                    onChangeText={(value) => updateMissingData('gender', value)}
                    onFocus={handleModalFocus}
                    placeholder="Gender"
                  />
                </View>
              )}
              {requiredMissingKeys.includes('occupation') && (
                <View style={styles.modalField}>
                  <Text style={styles.modalLabel}>Occupation *</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={missingData.occupation}
                    onChangeText={(value) => updateMissingData('occupation', value)}
                    onFocus={handleModalFocus}
                    placeholder="Occupation"
                  />
                </View>
              )}

              <Text style={styles.modalSectionTitle}>Vitals</Text>
              {requiredMissingKeys.includes('spo2') && (
                <View style={styles.modalField}>
                  <Text style={styles.modalLabel}>SpO2 *</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={missingData.spo2}
                    onChangeText={(value) => updateMissingData('spo2', value)}
                    onFocus={handleModalFocus}
                    placeholder="SpO2"
                    keyboardType="number-pad"
                  />
                </View>
              )}
              {requiredMissingKeys.includes('bp') && (
                <View style={styles.modalField}>
                  <Text style={styles.modalLabel}>BP *</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={missingData.bp}
                    onChangeText={(value) => updateMissingData('bp', value)}
                    onFocus={handleModalFocus}
                    placeholder="BP"
                  />
                </View>
              )}
              {requiredMissingKeys.includes('hr') && (
                <View style={styles.modalField}>
                  <Text style={styles.modalLabel}>HR *</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={missingData.hr}
                    onChangeText={(value) => updateMissingData('hr', value)}
                    onFocus={handleModalFocus}
                    placeholder="HR"
                    keyboardType="number-pad"
                  />
                </View>
              )}
              {requiredMissingKeys.includes('rr') && (
                <View style={styles.modalField}>
                  <Text style={styles.modalLabel}>RR *</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={missingData.rr}
                    onChangeText={(value) => updateMissingData('rr', value)}
                    onFocus={handleModalFocus}
                    placeholder="RR"
                    keyboardType="number-pad"
                  />
                </View>
              )}
              {requiredMissingKeys.includes('weight') && (
                <View style={styles.modalField}>
                  <Text style={styles.modalLabel}>Weight *</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={missingData.weight}
                    onChangeText={(value) => updateMissingData('weight', value)}
                    onFocus={handleModalFocus}
                    placeholder="Weight"
                    keyboardType="decimal-pad"
                  />
                </View>
              )}
              {requiredMissingKeys.includes('height') && (
                <View style={styles.modalField}>
                  <Text style={styles.modalLabel}>Height *</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={missingData.height}
                    onChangeText={(value) => updateMissingData('height', value)}
                    onFocus={handleModalFocus}
                    placeholder="Height"
                    keyboardType="decimal-pad"
                  />
                </View>
              )}
              {requiredMissingKeys.includes('bmi') && (
                <View style={styles.modalField}>
                  <Text style={styles.modalLabel}>BMI *</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={missingData.bmi}
                    onChangeText={(value) => updateMissingData('bmi', value)}
                    onFocus={handleModalFocus}
                    placeholder="BMI"
                    keyboardType="decimal-pad"
                  />
                </View>
              )}
              <View style={{height: keyboardHeight}} />
              </View>
            </ScrollView>
            <TouchableOpacity
              style={[
                styles.modalSubmit,
                !isMissingFormValid && styles.modalSubmitDisabled,
              ]}
              onPress={handleSubmitMissingData}
              activeOpacity={0.8}
              disabled={!isMissingFormValid}>
              <Text style={styles.modalSubmitText}>Save and Continue</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={proformaModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setProformaModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {selectedProforma?.title || 'Proforma'}
            </Text>
            {isRecording && (
              <View style={styles.proformaRecordingBanner}>
                <Ionicons name="mic" size={16} color="#DC2626" />
                <Text style={styles.proformaRecordingTimer}>{formatDuration(recordingSeconds)}</Text>
              </View>
            )}
            <ScrollView style={styles.modalForm}>
              <Text style={styles.proformaContent}>
                {selectedProforma?.content || ''}
              </Text>
            </ScrollView>
            <View style={styles.proformaModalActions}>
              {isRecording && (
                <TouchableOpacity
                  style={styles.proformaStopButton}
                  onPress={() => {
                    setProformaModalVisible(false);
                    handleStopRecording();
                  }}
                  activeOpacity={0.8}>
                  <Ionicons name="stop" size={18} color="#FFFFFF" />
                  <Text style={styles.proformaStopButtonText}>Stop Recording</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.modalSubmit, {flex: 1}]}
                onPress={() => setProformaModalVisible(false)}
                activeOpacity={0.8}>
                <Text style={styles.modalSubmitText}>Close</Text>
              </TouchableOpacity>
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
    backgroundColor: '#F8FAFC',
  },
  scrollView: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  contentInner: {
    width: '100%',
    alignItems: 'center',
  },
  proformaSection: {
    width: '100%',
    maxWidth: 500,
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 6},
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 3,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 12,
  },
  proformaSearchWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    height: 44,
    marginBottom: 12,
  },
  proformaSearchInput: {
    flex: 1,
    marginLeft: 8,
    fontSize: 15,
    color: '#1E293B',
  },
  proformaCreateWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    height: 44,
    marginBottom: 12,
  },
  proformaCreateInput: {
    flex: 1,
    marginLeft: 8,
    fontSize: 14,
    color: '#1E293B',
  },
  proformaCreateButton: {
    backgroundColor: '#0D9488',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginLeft: 8,
  },
  proformaCreateButtonDisabled: {
    opacity: 0.6,
  },
  proformaCreateButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  proformaList: {
    gap: 10,
  },
  proformaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FAFAFA',
  },
  proformaItemText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1E293B',
  },
  proformaEmpty: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  proformaEmptyText: {
    fontSize: 13,
    color: '#94A3B8',
  },
  iconContainer: {
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1E293B',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 24,
  },
  formContainer: {
    width: '100%',
    maxWidth: 400,
    marginBottom: 32,
  },
  inputContainer: {
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1E293B',
    marginBottom: 8,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    height: 50,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 6},
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  inputIcon: {
    marginRight: 8,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: '#1E293B',
  },
  patientInfoContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 24,
    width: '100%',
    maxWidth: 400,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 6},
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 3,
  },
  patientInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  timerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  patientInfoText: {
    fontSize: 16,
    color: '#1E293B',
    marginLeft: 8,
    fontWeight: '500',
  },
  timerText: {
    fontSize: 16,
    color: '#DC2626',
    marginLeft: 8,
    fontWeight: '700',
    letterSpacing: 1,
  },
  recordButton: {
    backgroundColor: '#0D9488',
    paddingVertical: 20,
    paddingHorizontal: 40,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 200,
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 8},
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 4,
  },
  recordButtonRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
    maxWidth: 500,
  },
  recordButtonInRow: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 16,
  },
  recordButtonActive: {
    backgroundColor: '#DC2626',
  },
  recordButtonDisabled: {
    backgroundColor: '#94A3B8',
    opacity: 0.6,
  },
  recordButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
    marginLeft: 12,
  },
  retryCard: {
    marginTop: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  retryTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 4,
  },
  retrySubtitle: {
    fontSize: 13,
    color: '#64748B',
    marginBottom: 10,
  },
  retryButton: {
    backgroundColor: '#DC2626',
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  retryButtonDisabled: {
    opacity: 0.6,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    padding: 20,
  },
  consentModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    padding: 20,
  },
  consentModalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 18,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 8},
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 6,
  },
  consentModalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 6,
  },
  consentModalBody: {
    fontSize: 14,
    color: '#64748B',
    lineHeight: 20,
  },
  consentModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  consentModalCancel: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginRight: 10,
  },
  consentModalCancelText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '600',
  },
  consentModalAgree: {
    backgroundColor: '#0D9488',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  consentModalAgreeText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  consentCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 8},
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 6,
    width: '100%',
  },
  consentHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  consentIcon: {
    marginRight: 12,
  },
  consentTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1E293B',
  },
  consentText: {
    fontSize: 15,
    color: '#475569',
    lineHeight: 22,
    marginBottom: 24,
  },
  consentActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  consentButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 100,
  },
  consentButtonSecondary: {
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  consentButtonSecondaryText: {
    color: '#475569',
    fontSize: 15,
    fontWeight: '600',
  },
  consentButtonPrimary: {
    backgroundColor: '#0EA5E9',
  },
  consentButtonPrimaryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 20,
    maxHeight: '85%',
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 8},
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 6,
  },
  photoModalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 8},
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 6,
  },
  photoOptionButton: {
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8F8F8',
    alignItems: 'center',
    marginBottom: 10,
  },
  photoOptionPrimary: {
    backgroundColor: '#0D9488',
    borderColor: '#0D9488',
  },
  photoOptionText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1E293B',
  },
  photoOptionPrimaryText: {
    color: '#FFFFFF',
  },
  photoOptionDestructive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DC2626',
  },
  photoOptionDestructiveText: {
    color: '#DC2626',
  },
  photoOptionDisabled: {
    opacity: 0.6,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 6,
  },
  modalSubtitle: {
    fontSize: 14,
    color: '#64748B',
    marginBottom: 16,
  },
  modalForm: {
    marginBottom: 16,
  },
  proformaContent: {
    fontSize: 14,
    color: '#1E293B',
    lineHeight: 20,
  },
  proformaRecordingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFF5F5',
    borderRadius: 8,
    paddingVertical: 6,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#FFD0D0',
  },
  proformaRecordingTimer: {
    fontSize: 15,
    fontWeight: '700',
    color: '#DC2626',
    marginLeft: 6,
  },
  proformaModalActions: {
    flexDirection: 'row',
    gap: 10,
  },
  proformaStopButton: {
    flex: 1,
    backgroundColor: '#DC2626',
    paddingVertical: 14,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  proformaStopButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    marginLeft: 6,
  },
  autoProformaSection: {
    backgroundColor: '#F0FFF4',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#C6F6D5',
    width: '100%',
    maxWidth: 500,
  },
  autoProformaButton: {
    backgroundColor: '#059669',
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  autoProformaButtonInRow: {
    flex: 1,
    marginTop: 0,
    paddingVertical: 20,
    paddingHorizontal: 12,
    borderRadius: 18,
  },
  autoProformaButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  diagnosisSection: {
    backgroundColor: '#F0F7FF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#D0E4FF',
  },
  diagnosisSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  diagnosisSectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0D9488',
    marginLeft: 8,
  },
  diagnosisSectionSubtitle: {
    fontSize: 13,
    color: '#64748B',
    lineHeight: 18,
    marginBottom: 12,
  },
  diagnosisCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 14,
    marginBottom: 14,
  },
  diagnosisContent: {
    fontSize: 14,
    color: '#1E293B',
    lineHeight: 22,
  },
  answerButton: {
    backgroundColor: '#0D9488',
    borderRadius: 10,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  answerButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  answerRecordingContainer: {
    alignItems: 'center',
  },
  answerRecordingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  answerRecordingTimer: {
    fontSize: 22,
    fontWeight: '700',
    color: '#DC2626',
    marginLeft: 8,
    marginRight: 10,
  },
  answerRecordingLabel: {
    fontSize: 14,
    color: '#64748B',
  },
  answerStopButton: {
    backgroundColor: '#DC2626',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  answerStopButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  answerSubmittingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
  },
  answerSubmittingText: {
    fontSize: 15,
    color: '#0D9488',
    fontWeight: '500',
    marginLeft: 10,
  },
  modalSectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1E293B',
    marginBottom: 8,
    marginTop: 4,
  },
  modalField: {
    marginBottom: 12,
  },
  modalLabel: {
    fontSize: 13,
    color: '#1E293B',
    marginBottom: 6,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 15,
    color: '#1E293B',
    backgroundColor: '#FAFAFA',
  },
  modalSubmit: {
    backgroundColor: '#0D9488',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalSubmitDisabled: {
    backgroundColor: '#94A3B8',
  },
  modalSubmitText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});

export default React.memo(RecordPage);
