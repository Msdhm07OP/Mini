import { useState, useEffect } from 'react';
import { getBookings, getVenues, cancelBooking, rescheduleBooking, addToWaitlist } from '../services/api';
import { Calendar, MapPin, Users, Projector, Volume2, UserCircle, X, Edit2 } from 'lucide-react';

export default function BookingList({ refreshTrigger }) {
  const [bookings, setBookings] = useState([]);
  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: '', venue_id: '', event_date: '' });
  const [rescheduleData, setRescheduleData] = useState(null);

  useEffect(() => {
    loadData();
  }, [refreshTrigger, filter]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [bookingsRes, venuesRes] = await Promise.all([
        getBookings(filter),
        getVenues()
      ]);
      setBookings(bookingsRes.data);
      setVenues(venuesRes.data);
    } catch (error) {
      console.error('Error loading bookings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async (id) => {
    if (!confirm('Are you sure you want to cancel this booking?')) return;

    try {
      await cancelBooking(id);
      alert('Booking cancelled successfully');
      loadData();
    } catch (error) {
      alert('Error cancelling booking: ' + error.message);
    }
  };

  const handleJoinWaitlist = async (booking) => {
    try {
      const response = await addToWaitlist(booking.id, 'Client requested to wait for a released slot');
      await loadData();
      alert(response.data?.message || 'Waitlist request updated.');
    } catch (error) {
      alert('Could not add request to waitlist: ' + (error.response?.data?.message || error.message));
    }
  };

  const handleReschedule = async (booking) => {
    setRescheduleData({
      id: booking.id,
      client_id: booking.client_id,
      event_name: booking.event_name,
      event_date: booking.event_date,
      event_start: String(booking.event_start || '').slice(0, 5),
      event_end: String(booking.event_end || '').slice(0, 5),
      attendees: booking.attendees,
      preferred_venue_id: booking.preferred_venue_id || booking.venue_id,
      projectors_requested: booking.projectors_requested,
      audio_systems_requested: booking.audio_systems_requested,
      staff_requested: booking.staff_requested,
    });
  };

  const submitReschedule = async (e) => {
    e.preventDefault();
    try {
      const { id, ...data } = rescheduleData;
      await rescheduleBooking(id, data);
      alert('Booking rescheduled successfully');
      setRescheduleData(null);
      loadData();
    } catch (error) {
      alert('Error rescheduling: ' + (error.response?.data?.message || error.message));
    }
  };

  const getStatusBadge = (status) => {
    const badges = {
      confirmed: 'badge-success',
      cancelled: 'badge-warning',
      rejected: 'badge-danger',
      waitlisted: 'badge-info',
    };
    return `badge ${badges[status] || 'badge-info'}`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Bookings</h2>
        <p className="text-gray-600 mt-1">View and manage all event bookings</p>
      </div>

      {/* Filters */}
      <div className="card p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="label">Status</label>
            <select
              value={filter.status}
              onChange={(e) => setFilter(prev => ({ ...prev, status: e.target.value }))}
              className="input"
            >
              <option value="">All Status</option>
              <option value="confirmed">Confirmed</option>
              <option value="cancelled">Cancelled</option>
              <option value="rejected">Rejected</option>
              <option value="waitlisted">Waitlisted</option>
            </select>
          </div>
          <div>
            <label className="label">Venue</label>
            <select
              value={filter.venue_id}
              onChange={(e) => setFilter(prev => ({ ...prev, venue_id: e.target.value }))}
              className="input"
            >
              <option value="">All Venues</option>
              {venues.map(v => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Date</label>
            <input
              type="date"
              value={filter.event_date}
              onChange={(e) => setFilter(prev => ({ ...prev, event_date: e.target.value }))}
              className="input"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={() => setFilter({ status: '', venue_id: '', event_date: '' })}
              className="btn btn-secondary w-full"
            >
              Clear Filters
            </button>
          </div>
        </div>
      </div>

      {/* Reschedule Modal */}
      {rescheduleData && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl font-bold">Reschedule Booking</h3>
                <button onClick={() => setRescheduleData(null)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <form onSubmit={submitReschedule} className="space-y-4">
                <div>
                  <label className="label">Event Name</label>
                  <input
                    type="text"
                    value={rescheduleData.event_name}
                    onChange={(e) => setRescheduleData(prev => ({ ...prev, event_name: e.target.value }))}
                    className="input"
                    required
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="label">Date</label>
                    <input
                      type="date"
                      value={rescheduleData.event_date}
                      onChange={(e) => setRescheduleData(prev => ({ ...prev, event_date: e.target.value }))}
                      className="input"
                      required
                    />
                  </div>
                  <div>
                    <label className="label">Start</label>
                    <input
                      type="time"
                      value={rescheduleData.event_start}
                      onChange={(e) => setRescheduleData(prev => ({ ...prev, event_start: e.target.value }))}
                      className="input"
                      required
                    />
                  </div>
                  <div>
                    <label className="label">End</label>
                    <input
                      type="time"
                      value={rescheduleData.event_end}
                      onChange={(e) => setRescheduleData(prev => ({ ...prev, event_end: e.target.value }))}
                      className="input"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">Attendees</label>
                    <input
                      type="number"
                      value={rescheduleData.attendees}
                      onChange={(e) => setRescheduleData(prev => ({ ...prev, attendees: parseInt(e.target.value) }))}
                      className="input"
                      min="1"
                      required
                    />
                  </div>
                  <div>
                    <label className="label">Preferred Venue</label>
                    <select
                      value={rescheduleData.preferred_venue_id}
                      onChange={(e) => setRescheduleData(prev => ({ ...prev, preferred_venue_id: parseInt(e.target.value) }))}
                      className="input"
                      required
                    >
                      {venues.map(v => (
                        <option key={v.id} value={v.id}>{v.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex justify-end space-x-3">
                  <button type="button" onClick={() => setRescheduleData(null)} className="btn btn-secondary">
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary">
                    Confirm Reschedule
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Bookings List */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading bookings...</div>
      ) : bookings.length === 0 ? (
        <div className="card p-12 text-center">
          <Calendar className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <p className="text-gray-600">No bookings found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {bookings.map(booking => (
            <div key={booking.id} className="card p-6 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center space-x-3 mb-2">
                    <h3 className="text-lg font-semibold text-gray-900">{booking.event_name}</h3>
                    <span className={getStatusBadge(booking.status)}>
                      {booking.status.toUpperCase()}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-sm text-gray-600">
                    <div className="flex items-center space-x-2">
                      <UserCircle className="w-4 h-4" />
                      <span>{booking.client_name}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Calendar className="w-4 h-4" />
                      <span>{booking.event_date} | {String(booking.event_start).slice(0, 5)} - {String(booking.event_end).slice(0, 5)}</span>
                    </div>
                    {booking.hall_name && (
                      <div className="flex items-center space-x-2">
                        <MapPin className="w-4 h-4" />
                        <span>{booking.venue_name} - {booking.hall_name}</span>
                      </div>
                    )}
                    <div className="flex items-center space-x-2">
                      <Users className="w-4 h-4" />
                      <span>{booking.attendees} attendees</span>
                    </div>
                    {booking.projectors_requested > 0 && (
                      <div className="flex items-center space-x-2">
                        <Projector className="w-4 h-4" />
                        <span>{booking.projectors_requested} projector(s)</span>
                      </div>
                    )}
                    {booking.audio_systems_requested > 0 && (
                      <div className="flex items-center space-x-2">
                        <Volume2 className="w-4 h-4" />
                        <span>{booking.audio_systems_requested} audio system(s)</span>
                      </div>
                    )}
                  </div>

                  {booking.status === 'confirmed' && (
                    <div className="mt-3 text-xs text-gray-500">
                      Reserved: {booking.reserved_start} - {booking.reserved_end} (includes 30min setup/cleanup)
                    </div>
                  )}

                  {booking.rejection_reason && (
                    <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                      <strong>Rejection Reason:</strong> {booking.rejection_reason}
                    </div>
                  )}
                </div>

                <div className="flex flex-col space-y-2 ml-4">
                {booking.status === 'confirmed' && (
                  <>
                    <button
                      onClick={() => handleReschedule(booking)}
                      className="btn btn-secondary text-sm flex items-center space-x-1"
                    >
                      <Edit2 className="w-3 h-3" />
                      <span>Reschedule</span>
                    </button>
                    <button
                      onClick={() => handleCancel(booking.id)}
                      className="btn btn-danger text-sm flex items-center space-x-1"
                    >
                      <X className="w-3 h-3" />
                      <span>Cancel</span>
                    </button>
                  </>
                )}
                {booking.status === 'rejected' && (
                  <button onClick={() => handleJoinWaitlist(booking)} className="btn btn-secondary text-sm whitespace-nowrap">
                    Join waitlist
                  </button>
                )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
