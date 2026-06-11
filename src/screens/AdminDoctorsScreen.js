import React, {useState, useEffect, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Modal,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import apiService from '../services/apiService';

export default function AdminDoctorsScreen() {
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [expandedDocId, setExpandedDocId] = useState(null);

  // Add Doctor Modal
  const [isAddDoctorVisible, setIsAddDoctorVisible] = useState(false);
  const [newDoctorName, setNewDoctorName] = useState('');
  const [newDoctorEmail, setNewDoctorEmail] = useState('');

  // Assign Tenant Modal
  const [isAssignVisible, setIsAssignVisible] = useState(false);
  const [selectedDoctorId, setSelectedDoctorId] = useState(null);
  const [tenantNurseId, setTenantNurseId] = useState('');

  const fetchDoctors = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    setError(null);
    try {
      const result = await apiService.getAdminDoctors();
      if (result.success) {
        setDoctors(result.data || []);
      } else {
        setError(result.error || 'Failed to fetch doctors');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchDoctors();
  }, [fetchDoctors]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDoctors(true);
  }, [fetchDoctors]);

  const toggleExpand = (id) => {
    setExpandedDocId(expandedDocId === id ? null : id);
  };

  const handleAddDoctor = async () => {
    if (!newDoctorName || !newDoctorEmail) {
      Alert.alert('Error', 'Please enter both name and email');
      return;
    }
    try {
      const result = await apiService.createAdminDoctor({
        name: newDoctorName,
        email: newDoctorEmail,
      });
      if (result.success) {
        Alert.alert('Success', 'Doctor created successfully');
        setIsAddDoctorVisible(false);
        setNewDoctorName('');
        setNewDoctorEmail('');
        fetchDoctors();
      } else {
        Alert.alert('Error', result.error || 'Failed to create doctor');
      }
    } catch (err) {
      Alert.alert('Error', 'Network error');
    }
  };

  const handleAssignTenant = async () => {
    if (!tenantNurseId) {
      Alert.alert('Error', 'Please enter a Nurse ID');
      return;
    }
    try {
      const result = await apiService.assignDoctorTenant(selectedDoctorId, tenantNurseId);
      if (result.success) {
        Alert.alert('Success', 'Nurse assigned successfully');
        setIsAssignVisible(false);
        setTenantNurseId('');
        fetchDoctors();
      } else {
        Alert.alert('Error', result.error || 'Failed to assign nurse');
      }
    } catch (err) {
      Alert.alert('Error', 'Network error');
    }
  };

  const handleRemoveTenant = async (doctorId, nurseId) => {
    Alert.alert(
      'Remove Assignment',
      'Are you sure you want to remove this nurse from the doctor?',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              const result = await apiService.removeDoctorTenant(doctorId, nurseId);
              if (result.success) {
                Alert.alert('Success', 'Nurse removed successfully');
                fetchDoctors();
              } else {
                Alert.alert('Error', result.error || 'Failed to remove nurse');
              }
            } catch (err) {
              Alert.alert('Error', 'Network error');
            }
          },
        },
      ]
    );
  };

  const openAssignModal = (doctorId) => {
    setSelectedDoctorId(doctorId);
    setIsAssignVisible(true);
  };

  const renderDoctorCard = ({item}) => {
    const isExpanded = expandedDocId === item.id;

    return (
      <View style={styles.card}>
        <TouchableOpacity 
          style={styles.cardHeader} 
          onPress={() => toggleExpand(item.id)}
          activeOpacity={0.7}
        >
          <View style={styles.cardHeaderTop}>
            <View style={styles.doctorInfo}>
              <Text style={styles.doctorName}>{item.name}</Text>
              <Text style={styles.doctorEmail}>{item.email}</Text>
            </View>
            <View style={styles.roleBadge}>
              <Text style={styles.roleText}>{item.role}</Text>
            </View>
          </View>

          <View style={styles.cardHeaderBottom}>
            <Text style={styles.tenantCountText}>
              {item.tenants?.length || 0} Assigned Nurses
            </Text>
            <Ionicons 
              name={isExpanded ? "chevron-up" : "chevron-down"} 
              size={20} 
              color="#94A3B8" 
            />
          </View>
        </TouchableOpacity>

        {isExpanded && (
          <View style={styles.expandedContent}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Assigned Nurses</Text>
              <TouchableOpacity 
                style={styles.assignButtonSm}
                onPress={() => openAssignModal(item.id)}
              >
                <Ionicons name="add" size={16} color="#0D9488" />
                <Text style={styles.assignButtonTextSm}>Assign Nurse</Text>
              </TouchableOpacity>
            </View>

            {item.tenants && item.tenants.length > 0 ? (
              item.tenants.map((t, i) => (
                <View key={i} style={styles.tenantItem}>
                  <View style={styles.tenantInfo}>
                    <Ionicons name="person-outline" size={16} color="#64748B" />
                    <View style={styles.tenantTextContainer}>
                      <Text style={styles.tenantName}>{t.nurse_name}</Text>
                      <Text style={styles.tenantEmail}>ID: {t.user_id}</Text>
                    </View>
                  </View>
                  <TouchableOpacity 
                    style={styles.removeTenantButton}
                    onPress={() => handleRemoveTenant(item.id, t.user_id)}
                  >
                    <Ionicons name="trash-outline" size={18} color="#EF4444" />
                  </TouchableOpacity>
                </View>
              ))
            ) : (
              <Text style={styles.noTenantsText}>No nurses assigned yet.</Text>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Doctors</Text>
          <Text style={styles.headerSubtitle}>Manage doctors and nurse assignments</Text>
        </View>
        <TouchableOpacity 
          style={styles.addDoctorButton}
          onPress={() => setIsAddDoctorVisible(true)}
        >
          <Ionicons name="add" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => fetchDoctors()}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : loading && !refreshing ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#0D9488" />
          <Text style={styles.loadingText}>Loading doctors...</Text>
        </View>
      ) : (
        <FlatList
          data={doctors}
          keyExtractor={(item) => item.id.toString()}
          renderItem={renderDoctorCard}
          contentContainerStyle={styles.listContainer}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={['#0D9488']}
              tintColor="#0D9488"
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="medkit-outline" size={48} color="#CBD5E1" />
              <Text style={styles.emptyTitle}>No Doctors Found</Text>
              <Text style={styles.emptyText}>Add a doctor to get started.</Text>
            </View>
          }
        />
      )}

      {/* Add Doctor Modal */}
      <Modal visible={isAddDoctorVisible} animationType="slide" transparent>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Doctor</Text>
              <TouchableOpacity onPress={() => setIsAddDoctorVisible(false)}>
                <Ionicons name="close" size={24} color="#64748B" />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Doctor Name</Text>
              <TextInput
                style={styles.input}
                placeholder="Dr. John Doe"
                value={newDoctorName}
                onChangeText={setNewDoctorName}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Email Address</Text>
              <TextInput
                style={styles.input}
                placeholder="john.doe@fkp.org"
                keyboardType="email-address"
                autoCapitalize="none"
                value={newDoctorEmail}
                onChangeText={setNewDoctorEmail}
              />
            </View>

            <TouchableOpacity style={styles.modalSubmitBtn} onPress={handleAddDoctor}>
              <Text style={styles.modalSubmitBtnText}>Create Doctor</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Assign Tenant Modal */}
      <Modal visible={isAssignVisible} animationType="slide" transparent>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Assign Nurse</Text>
              <TouchableOpacity onPress={() => setIsAssignVisible(false)}>
                <Ionicons name="close" size={24} color="#64748B" />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Nurse User ID</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g., 42"
                keyboardType="numeric"
                value={tenantNurseId}
                onChangeText={setTenantNurseId}
              />
            </View>

            <TouchableOpacity style={styles.modalSubmitBtn} onPress={handleAssignTenant}>
              <Text style={styles.modalSubmitBtnText}>Assign Nurse</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  header: {
    paddingTop: 60,
    paddingHorizontal: 24,
    paddingBottom: 20,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 16,
    color: '#64748B',
  },
  addDoctorButton: {
    backgroundColor: '#0D9488',
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#0D9488',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  listContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#F1F5F9',
  },
  cardHeader: {
    padding: 16,
  },
  cardHeaderTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  doctorInfo: {
    flex: 1,
    paddingRight: 12,
  },
  doctorName: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 4,
  },
  doctorEmail: {
    fontSize: 14,
    color: '#64748B',
    fontWeight: '500',
  },
  roleBadge: {
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  roleText: {
    color: '#4F46E5',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  cardHeaderBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  tenantCountText: {
    fontSize: 13,
    color: '#0D9488',
    fontWeight: '600',
  },
  expandedContent: {
    padding: 16,
    paddingTop: 0,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    backgroundColor: '#FAFAF9',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#475569',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  assignButtonSm: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F0FDFA',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  assignButtonTextSm: {
    color: '#0D9488',
    fontSize: 13,
    fontWeight: '600',
  },
  tenantItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  tenantInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  tenantTextContainer: {
    justifyContent: 'center',
  },
  tenantName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0F172A',
    marginBottom: 2,
  },
  tenantEmail: {
    fontSize: 12,
    color: '#64748B',
  },
  removeTenantButton: {
    padding: 8,
  },
  noTenantsText: {
    fontSize: 14,
    color: '#94A3B8',
    fontStyle: 'italic',
    marginTop: 8,
    marginBottom: 8,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#64748B',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    fontSize: 16,
    color: '#EF4444',
    marginBottom: 16,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: '#0D9488',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 16,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1E293B',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 16,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 24,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0F172A',
  },
  inputGroup: {
    marginBottom: 20,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#475569',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingHorizontal: 16,
    height: 48,
    fontSize: 15,
    color: '#1E293B',
  },
  modalSubmitBtn: {
    backgroundColor: '#0D9488',
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  modalSubmitBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
