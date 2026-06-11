import React, {useState, useEffect, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import apiService from '../services/apiService';

export default function AdminMetricsScreen() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const fetchMetrics = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    setError(null);
    try {
      const result = await apiService.getAdminMetrics();
      if (result.success) {
        setMetrics(result);
      } else {
        setError(result.error || 'Failed to fetch metrics');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchMetrics(true);
  }, [fetchMetrics]);

  const formatCurrency = (val) => {
    if (val === undefined || val === null) return '$0.00';
    return `$${val.toFixed(2)}`;
  };

  const getRiskColor = (tier) => {
    if (!tier) return '#94A3B8';
    const t = tier.toUpperCase();
    if (t === 'EMERGENCY' || t === 'HIGH') return '#EF4444';
    if (t === 'MEDIUM') return '#F59E0B';
    if (t === 'LOW') return '#10B981';
    return '#94A3B8';
  };

  if (loading && !refreshing) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" color="#0D9488" />
        <Text style={styles.loadingText}>Loading metrics...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  const { system, per_nurse } = metrics || { system: {}, per_nurse: [] };

  return (
    <ScrollView 
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          colors={['#0D9488']}
          tintColor="#0D9488"
        />
      }
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Metrics & Usage</Text>
        <Text style={styles.headerSubtitle}>System-wide analytics</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>System Overview</Text>
        <View style={styles.statsGrid}>
          <View style={styles.statCard}>
            <Ionicons name="people-outline" size={24} color="#0D9488" />
            <Text style={styles.statValue}>{system.total_sessions || 0}</Text>
            <Text style={styles.statLabel}>Total Cases</Text>
          </View>
          <View style={styles.statCard}>
            <Ionicons name="medical-outline" size={24} color="#0D9488" />
            <Text style={styles.statValue}>{system.total_users || 0}</Text>
            <Text style={styles.statLabel}>Total Nurses</Text>
          </View>
          <View style={styles.statCard}>
            <Ionicons name="cash-outline" size={24} color="#0D9488" />
            <Text style={styles.statValue}>{formatCurrency(system.total_cost_usd)}</Text>
            <Text style={styles.statLabel}>Total LLM Cost</Text>
          </View>
          <View style={styles.statCard}>
            <Ionicons name="speedometer-outline" size={24} color="#0D9488" />
            <Text style={styles.statValue}>{system.avg_e2e_duration_ms ? (system.avg_e2e_duration_ms / 1000).toFixed(1) + 's' : '0s'}</Text>
            <Text style={styles.statLabel}>Avg Latency</Text>
          </View>
        </View>

        <View style={styles.statsRow}>
          <View style={[styles.statCardH, { flex: 1, marginRight: 8 }]}>
            <Text style={styles.statLabelH}>Cases Today</Text>
            <Text style={styles.statValueH}>{system.sessions_today || 0}</Text>
          </View>
          <View style={[styles.statCardH, { flex: 1, marginLeft: 8 }]}>
            <Text style={styles.statLabelH}>Failure Rate</Text>
            <Text style={[styles.statValueH, system.failure_rate_pct > 5 ? {color: '#EF4444'} : null]}>
              {system.failure_rate_pct || 0}%
            </Text>
          </View>
        </View>
      </View>

      {system.risk_distribution && Object.keys(system.risk_distribution).length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Risk Distribution</Text>
          <View style={styles.riskContainer}>
            {Object.entries(system.risk_distribution).map(([tier, count]) => (
              <View key={tier} style={styles.riskRow}>
                <View style={styles.riskLabelContainer}>
                  <View style={[styles.riskDot, { backgroundColor: getRiskColor(tier) }]} />
                  <Text style={styles.riskTierText}>{tier}</Text>
                </View>
                <Text style={styles.riskCountText}>{count}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Nurse Leaderboard</Text>
        {per_nurse && per_nurse.length > 0 ? (
          per_nurse.map((nurse, index) => (
            <View key={nurse.user_id} style={styles.nurseCard}>
              <View style={styles.nurseHeader}>
                <View style={styles.nurseRank}>
                  <Text style={styles.nurseRankText}>#{index + 1}</Text>
                </View>
                <View style={styles.nurseInfo}>
                  <Text style={styles.nurseName}>{nurse.name}</Text>
                  <Text style={styles.nurseEmail}>{nurse.email}</Text>
                </View>
              </View>
              <View style={styles.nurseStats}>
                <View style={styles.nStat}>
                  <Text style={styles.nStatVal}>{nurse.total_sessions}</Text>
                  <Text style={styles.nStatLabel}>Cases</Text>
                </View>
                <View style={styles.nStat}>
                  <Text style={styles.nStatVal}>{formatCurrency(nurse.total_cost_usd)}</Text>
                  <Text style={styles.nStatLabel}>Cost</Text>
                </View>
                <View style={styles.nStat}>
                  <Text style={styles.nStatVal}>
                    {nurse.avg_e2e_ms ? (nurse.avg_e2e_ms / 1000).toFixed(1) + 's' : '0s'}
                  </Text>
                  <Text style={styles.nStatLabel}>Avg Latency</Text>
                </View>
              </View>
            </View>
          ))
        ) : (
          <Text style={styles.emptyText}>No nurse activity yet.</Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollContent: {
    paddingBottom: 40,
  },
  header: {
    paddingTop: 60,
    paddingHorizontal: 24,
    paddingBottom: 20,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
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
  section: {
    padding: 16,
    marginTop: 8,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 16,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  statCard: {
    width: '48%',
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#F1F5F9',
  },
  statValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0F172A',
    marginTop: 12,
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 13,
    color: '#64748B',
    fontWeight: '500',
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statCardH: {
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#F1F5F9',
  },
  statLabelH: {
    fontSize: 14,
    color: '#64748B',
    fontWeight: '500',
  },
  statValueH: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0F172A',
  },
  riskContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#F1F5F9',
  },
  riskRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  riskLabelContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  riskDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  riskTierText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#334155',
    textTransform: 'uppercase',
  },
  riskCountText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
  },
  nurseCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#F1F5F9',
  },
  nurseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
    paddingBottom: 12,
  },
  nurseRank: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F0FDFA',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  nurseRankText: {
    color: '#0D9488',
    fontWeight: '700',
    fontSize: 14,
  },
  nurseInfo: {
    flex: 1,
  },
  nurseName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 2,
  },
  nurseEmail: {
    fontSize: 13,
    color: '#64748B',
  },
  nurseStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  nStat: {
    alignItems: 'center',
    flex: 1,
  },
  nStatVal: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 4,
  },
  nStatLabel: {
    fontSize: 12,
    color: '#64748B',
  },
  emptyText: {
    textAlign: 'center',
    color: '#94A3B8',
    marginTop: 20,
    fontStyle: 'italic',
  },
  loadingText: {
    marginTop: 16,
    color: '#64748B',
  },
  errorText: {
    color: '#EF4444',
  },
});
