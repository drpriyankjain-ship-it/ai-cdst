import React, {useContext} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import {AuthContext} from '../context/AuthContext';

const AboutPage = () => {
  const {logout} = useContext(AuthContext);

  const handleLogout = () => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            await logout();
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.scrollView}>
        <View style={styles.content}>
          <Text style={styles.sectionTitle}>How to Use</Text>
          <View style={styles.section}>
            <Text style={styles.stepTitle}>1. Sign up or log in</Text>
            <Text style={styles.stepText}>
              Register with your email and verify the OTP, then log in.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.stepTitle}>2. Create a new recording</Text>
            <Text style={styles.stepText}>
              Go to Record, enter patient basics, and tap Start Recording.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.stepTitle}>3. Speak your clinical notes</Text>
            <Text style={styles.stepText}>
              Describe the patient case clearly. The app will transcribe your speech.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.stepTitle}>4. Stop and upload</Text>
            <Text style={styles.stepText}>
              Tap Stop, then Upload. The transcript is sent to the backend.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.stepTitle}>5. Review AI suggestions</Text>
            <Text style={styles.stepText}>
              Go to Home to see AI suggestions. Tap any suggestion to expand.
            </Text>
          </View>
          
          <View style={styles.section}>
            <Text style={styles.stepTitle}>6. Complete missing data (if prompted)</Text>
            <Text style={styles.stepText}>
              If a Missing Data form appears, fill it in to update the suggestion.
            </Text>
          </View>
          
          <View style={styles.section}>
            <Text style={styles.stepTitle}>7. Mark completed suggestions</Text>
            <Text style={styles.stepText}>
              Swipe right on a suggestion to mark it as complete.
            </Text>
          </View>
          
          <View style={styles.section}>
            <Text style={styles.stepTitle}>8. View history</Text>
            <Text style={styles.stepText}>
              Open History to see past transcripts and details.
            </Text>
          </View>

          <View style={styles.divider} />

          <Text style={styles.sectionTitle}>About Us</Text>
          <View style={styles.section}>
            <Text style={styles.aboutText}>
              The Frontline Knowledge Project envisions a world where cutting-edge information technology reaches the most marginalized communities. We bridge the knowledge gap among non-physician healthcare workers by equipping them with AI-enabled tools that enhance clinical reasoning and improve quality of care in resource constrained settings.
            </Text>
            <Text style={styles.aboutText}>
              Grounded in implementation science and evidence generation, our ongoing "Nurse-AI" pilot in rural India will demonstrate if and how artificial intelligence can strengthen decision-making, diagnostic accuracy, and adherence to clinical guidelines. Our approach is user-centered, evidence-driven, and collaborative, developed with local NGOs and technology partners to ensure sustainability and impact.
            </Text>
            <Text style={styles.aboutText}>
              With proven results, we aim to take these pilots to national scale, building capacity and shaping policy to make AI-enabled primary care accessible across entire health systems. Your support will help us translate innovation into systemic change—advancing equity, evidence, and quality care where it is needed most.
            </Text>
          </View>

          <View style={styles.footer}>
            <Text style={styles.version}>Version 1.0.0</Text>
            
            <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
              <Ionicons name="log-out-outline" size={20} color="#DC2626" />
              <Text style={styles.logoutText}>Logout</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
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
    padding: 20,
  },
  sectionTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1E293B',
    marginBottom: 20,
    marginTop: 10,
  },
  section: {
    marginBottom: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 6},
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 3,
  },
  stepTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#0D9488',
    marginBottom: 8,
  },
  stepText: {
    fontSize: 16,
    color: '#64748B',
    lineHeight: 24,
  },
  divider: {
    height: 1,
    backgroundColor: '#E2E8F0',
    marginVertical: 24,
  },
  aboutText: {
    fontSize: 16,
    color: '#64748B',
    lineHeight: 24,
    marginBottom: 15,
  },
  footer: {
    marginTop: 30,
    marginBottom: 20,
    alignItems: 'center',
  },
  version: {
    fontSize: 14,
    color: '#94A3B8',
    marginBottom: 24,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DC2626',
    backgroundColor: '#FFFFFF',
  },
  logoutText: {
    fontSize: 16,
    color: '#DC2626',
    fontWeight: '600',
    marginLeft: 8,
  },
});

export default AboutPage;
