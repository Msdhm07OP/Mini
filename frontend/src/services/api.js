import axios from 'axios';
import { clearSession, getAccessToken, isSupabaseAuthConfigured, restoreSession } from './auth';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use(async config => {
  // Refresh a near-expiry Supabase session before sending API requests.
  // restoreSession is local-only for healthy sessions and refreshes only when needed.
  let token = getAccessToken();
  if (isSupabaseAuthConfigured) {
    const session = await restoreSession();
    token = session?.access_token || null;
  }
  if (token) config.headers.Authorization = `Bearer ${token}`;
  else if (config.headers?.Authorization) delete config.headers.Authorization;
  return config;
});

api.interceptors.response.use(response => response, error => {
  if (isSupabaseAuthConfigured && error.response?.status === 401) {
    clearSession();
    window.dispatchEvent(new Event('eventsync:auth-expired'));
  }
  return Promise.reject(error);
});

const unwrap = (promise, key) => promise.then(response => ({
  ...response,
  data: key ? response.data?.[key] : response.data,
}));

// Venues and clients: unwrap the API's envelope for UI components.
export const getVenues = () => unwrap(api.get('/venues'), 'venues');
export const getVenue = (id) => unwrap(api.get(`/venues/${id}`), 'venue');
export const getVenueBookings = (id, date) => unwrap(api.get(`/venues/${id}/bookings`, { params: { date } }), 'bookings');
export const getClients = () => unwrap(api.get('/clients'), 'clients');
export const getClient = (id) => unwrap(api.get(`/clients/${id}`), 'client');
export const createClient = (data) => unwrap(api.post('/clients', data), 'client');
export const getClientBookings = (id) => unwrap(api.get(`/clients/${id}/bookings`), 'bookings');

// Bookings
const cleanParams = params => Object.fromEntries(Object.entries(params || {}).filter(([, value]) => value !== '' && value !== null && value !== undefined));
export const getBookings = (params = {}) => unwrap(api.get('/bookings', { params: cleanParams(params) }), 'bookings');
export const getBooking = (id) => unwrap(api.get(`/bookings/${id}`), 'booking');
export const getBookingStats = () => unwrap(api.get('/bookings/stats'), 'stats');
export const createBooking = (data) => api.post('/bookings', data, {
  headers: { 'Idempotency-Key': globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}` },
});
export const createBookingSeries = (data) => api.post('/bookings/series', data, {
  headers: { 'Idempotency-Key': globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}` },
});
export const cancelBooking = (id, reason = 'Cancelled by operator') => api.post(`/bookings/${id}/cancel`, { reason });
export const rescheduleBooking = (id, data) => api.put(`/bookings/${id}/reschedule`, data);
export const getAlternatives = (data) => unwrap(api.post('/bookings/alternatives', data), 'alternatives');
export const getWaitlist = (eventDate) => unwrap(api.get('/bookings/waitlist', { params: eventDate ? { event_date: eventDate } : {} }), 'bookings');
export const addToWaitlist = (id, reason) => api.post(`/bookings/${id}/waitlist`, { reason });
export const getDecisionEvents = (params = {}) => unwrap(api.get('/bookings/decisions', { params }), 'events');

export default api;

// Analytics, data quality and simulation
const analyticsParams = params => Object.fromEntries(
  Object.entries(params || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined)
);
export const getAnalyticsOverview = (params = {}) => api.get('/analytics/overview', { params: analyticsParams(params) }).then(r => r.data);
export const getRequestOutcomes = (params = {}) => api.get('/analytics/outcomes', { params: analyticsParams(params) }).then(r => r.data);
export const getHallUtilisation = (params = {}) => api.get('/analytics/hall-utilisation', { params: analyticsParams(params) }).then(r => r.data);
export const getVenueUtilisation = (params = {}) => api.get('/analytics/venue-utilisation', { params: analyticsParams(params) }).then(r => r.data);
export const getResourceDemand = (params = {}) => api.get('/analytics/resource-demand', { params: analyticsParams(params) }).then(r => r.data);
export const getDemandHeatmap = (params = {}) => api.get('/analytics/demand-heatmap', { params: analyticsParams(params) }).then(r => r.data);
export const getRejectionAnalysis = (params = {}) => api.get('/analytics/rejections', { params: analyticsParams(params) }).then(r => r.data);
export const getDataQuality = (params = {}) => api.get('/analytics/data-quality', { params: analyticsParams(params) }).then(r => r.data);
export const runSimulation = (payload) => api.post('/simulations', payload).then(r => r.data);

/**
 * CSV download. The browser gets a blob rather than a navigation so that the
 * request still carries the API base URL and any future auth header.
 */
export const downloadCsv = async (dataset, params = {}) => {
  const response = await api.get(`/analytics/export/${dataset}`, {
    params: analyticsParams(params), responseType: 'blob',
  });
  const url = URL.createObjectURL(new Blob([response.data], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `eventsync-${dataset}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

// Digital staff event orders (BEOs)
export const getEventOrders = (eventDate) => unwrap(api.get('/event-orders', { params: eventDate ? { event_date: eventDate } : {} }), 'event_orders');
export const updateEventOrder = (bookingId, data) => api.put(`/event-orders/${bookingId}`, data).then(r => r.data);

// Client self-service portal
export const getPortalVenues = () => unwrap(api.get('/portal/venues'), 'venues');
export const getMyBookings = () => unwrap(api.get('/portal/bookings'), 'bookings');
export const requestPortalBooking = (data) => api.post('/portal/bookings', data, {
  headers: { 'Idempotency-Key': globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}` },
}).then(r => r.data);

// Account approvals (admin only)
export const getUsers = () => unwrap(api.get('/users'), 'users');
export const updateUserRole = (userId, role) => api.patch(`/users/${userId}/role`, { role });
