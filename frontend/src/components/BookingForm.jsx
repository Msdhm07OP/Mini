import { useState, useEffect } from 'react';
import { createBooking, createBookingSeries, getVenues, getClients, createClient, getAlternatives } from '../services/api';
import { AlertCircle, CheckCircle, Lightbulb } from 'lucide-react';

export default function BookingForm({ onSuccess }) {
  const [venues, setVenues] = useState([]);
  const [clients, setClients] = useState([]);
  const [showNewClient, setShowNewClient] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [alternatives, setAlternatives] = useState([]);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [seriesMode, setSeriesMode] = useState(false);
  const [seriesOccurrences, setSeriesOccurrences] = useState(6);
  const [seriesEveryDays, setSeriesEveryDays] = useState(7);

  const [formData, setFormData] = useState({
    client_id: '',
    event_name: '',
    event_date: '',
    event_start: '',
    event_end: '',
    attendees: '',
    preferred_venue_id: '',
    projectors_requested: 0,
    audio_systems_requested: 0,
    staff_requested: 0,
    waitlist_if_full: false,
  });

  const [newClient, setNewClient] = useState({
    name: '',
    email: '',
    phone: '',
    organization: '',
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [venuesRes, clientsRes] = await Promise.all([getVenues(), getClients()]);
      setVenues(venuesRes.data);
      setClients(clientsRes.data);
    } catch (error) {
      console.error('Error loading data:', error);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: ['client_id', 'attendees', 'preferred_venue_id', 'projectors_requested', 'audio_systems_requested', 'staff_requested'].includes(name)
        ? parseInt(value) || (name.includes('requested') ? 0 : '')
        : value
    }));
  };

  const handleNewClientChange = (e) => {
    const { name, value } = e.target;
    setNewClient(prev => ({ ...prev, [name]: value }));
  };

  const handleCreateClient = async (e) => {
    e.preventDefault();
    try {
      const response = await createClient(newClient);
      setClients(prev => [...prev, response.data]);
      setFormData(prev => ({ ...prev, client_id: response.data.id }));
      setNewClient({ name: '', email: '', phone: '', organization: '' });
      setShowNewClient(false);
    } catch (error) {
      alert('Error creating client: ' + (error.response?.data?.errors?.join(', ') || error.message));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    setAlternatives([]);
    setShowAlternatives(false);

    try {
      const response = seriesMode
        ? await createBookingSeries({ ...formData, waitlist_if_full: false, occurrences: Number(seriesOccurrences), every_days: Number(seriesEveryDays), all_or_nothing: true })
        : await createBooking(formData);
      setResult(response.data);

      if (response.data.success || response.data.waitlisted) {
        // Success
        setTimeout(() => {
          setFormData({
            client_id: '', event_name: '', event_date: '', event_start: '', event_end: '', attendees: '',
            preferred_venue_id: '', projectors_requested: 0, audio_systems_requested: 0, staff_requested: 0,
            waitlist_if_full: false,
          });
          setResult(null);
          if (onSuccess) onSuccess();
        }, 3000);
      } else if (!seriesMode) {
        // Preview alternatives without writing temporary bookings.
        try {
          const altResponse = await getAlternatives(formData);
          setAlternatives(altResponse.data || []);
        } catch (error) {
          console.error('Error fetching alternatives:', error);
        }
      }
    } catch (error) {
      console.error('Error creating booking:', error);
      const serverResult = error.response?.data;
      if (serverResult && typeof serverResult === 'object') {
        setResult(serverResult);
        // A rejected allocation is a business outcome, not a transport failure.
        // Preserve its decision details and still fetch read-only alternatives.
        if (!seriesMode && serverResult.booking && !serverResult.success && !serverResult.waitlisted) {
          try {
            const altResponse = await getAlternatives(formData);
            setAlternatives(altResponse.data || []);
          } catch (alternativeError) {
            console.error('Error fetching alternatives:', alternativeError);
          }
        }
      } else {
        setResult({ success: false, message: error.message || 'The request could not be processed.' });
      }
    } finally {
      setLoading(false);
    }
  };

  const applyAlternative = (alt) => {
    setFormData(prev => ({
      ...prev,
      event_date: alt.event_date,
      event_start: alt.event_start,
      event_end: alt.event_end,
      preferred_venue_id: alt.venue_id,
    }));
    setShowAlternatives(false);
    setAlternatives([]);
    setResult(null);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Create Event Booking</h2>
        <p className="text-gray-600 mt-1">Request a new event with venue and resource allocation</p>
      </div>

      {/* Result Messages */}
      {result && (
        <div className={`p-4 rounded-lg border ${result.success || result.waitlisted ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          <div className="flex items-start space-x-3">
            {result.success || result.waitlisted ? (
              <CheckCircle className="w-5 h-5 text-green-600 mt-0.5" />
            ) : (
              <AlertCircle className="w-5 h-5 text-red-600 mt-0.5" />
            )}
            <div className="flex-1">
              <h4 className={`font-semibold ${result.success || result.waitlisted ? 'text-green-900' : 'text-red-900'}`}>
                {result.success ? (result.series_id ? 'Recurring Series Created' : 'Booking Confirmed!') : (result.waitlisted ? 'Request Waitlisted' : (seriesMode ? 'Series Not Created' : (result.booking ? 'Booking Rejected' : 'Request Could Not Be Processed')))}
              </h4>
              <p className={`text-sm mt-1 ${result.success || result.waitlisted ? 'text-green-700' : 'text-red-700'}`}>
                {result.message}
              </p>
              {result.series_id && <p className="text-xs text-green-700 mt-2">Series ID: {result.series_id} · {result.bookings?.length || 0} occurrences saved.</p>}
              {result.booking && result.success && (
                <div className="mt-2 text-sm text-green-800">
                  <strong>Details:</strong> {result.booking.venue_name} - {result.booking.hall_name} |
                  Reserved: {String(result.booking.reserved_start).slice(0, 5)} - {String(result.booking.reserved_end).slice(0, 5)}
                </div>
              )}
            </div>
          </div>

          {!result.success && !result.waitlisted && !seriesMode && alternatives.length > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setShowAlternatives(!showAlternatives)}
                className="btn btn-secondary text-sm flex items-center space-x-2"
              >
                <Lightbulb className="w-4 h-4" />
                <span>{showAlternatives ? 'Hide' : 'Show'} Alternative Suggestions ({alternatives.length})</span>
              </button>

              {showAlternatives && (
                <div className="mt-3 space-y-2">
                  {alternatives.map((alt, idx) => (
                    <div key={idx} className="bg-white p-3 rounded border border-gray-200 flex items-center justify-between">
                      <div className="text-sm">
                        <p className="font-medium text-gray-900">{alt.venue_name} - {alt.hall_name}</p>
                        <p className="text-gray-600">{alt.event_date} | {alt.event_start} - {alt.event_end}</p>
                        <p className="text-gray-500 text-xs mt-1">{alt.reason}</p>
                      </div>
                      <button
                        onClick={() => applyAlternative(alt)}
                        className="btn btn-primary text-sm"
                      >
                        Use This
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Booking Form */}
      <form onSubmit={handleSubmit} className="card p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 rounded-lg bg-gray-50 border border-gray-200 p-4">
          <label className="flex items-start gap-3 text-sm text-gray-700">
            <input type="checkbox" checked={formData.waitlist_if_full} disabled={seriesMode} onChange={e => setFormData(prev => ({ ...prev, waitlist_if_full: e.target.checked }))} className="mt-1" />
            <span><strong>Join waitlist if unavailable</strong><span className="block text-xs text-gray-500 mt-1">The request is retried automatically when capacity is released.</span></span>
          </label>
          <label className="flex items-start gap-3 text-sm text-gray-700">
            <input type="checkbox" checked={seriesMode} onChange={e => { setSeriesMode(e.target.checked); if (e.target.checked) setFormData(prev => ({ ...prev, waitlist_if_full: false })); }} className="mt-1" />
            <span><strong>Create a recurring series</strong><span className="block text-xs text-gray-500 mt-1">All occurrences are confirmed together or none are written.</span></span>
          </label>
          {seriesMode && <div className="md:col-span-2 grid grid-cols-2 gap-4">
            <div><label className="label">Occurrences (2–52)</label><input type="number" min="2" max="52" value={seriesOccurrences} onChange={e => setSeriesOccurrences(e.target.value)} className="input" required /></div>
            <div><label className="label">Repeat every (days)</label><input type="number" min="1" max="365" value={seriesEveryDays} onChange={e => setSeriesEveryDays(e.target.value)} className="input" required /></div>
          </div>}
        </div>
        {/* Client Selection */}
        <div>
          <label className="label">Client *</label>
          {!showNewClient ? (
            <div className="flex space-x-2">
              <select
                name="client_id"
                value={formData.client_id}
                onChange={handleInputChange}
                className="input flex-1"
                required
              >
                <option value="">Select a client</option>
                {clients.map(client => (
                  <option key={client.id} value={client.id}>
                    {client.name} {client.organization ? `(${client.organization})` : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setShowNewClient(true)}
                className="btn btn-secondary whitespace-nowrap"
              >
                New Client
              </button>
            </div>
          ) : (
            <div className="border border-gray-300 rounded-lg p-4 space-y-3">
              <input
                type="text"
                name="name"
                placeholder="Client Name *"
                value={newClient.name}
                onChange={handleNewClientChange}
                className="input"
                required
              />
              <input
                type="email"
                name="email"
                placeholder="Email"
                value={newClient.email}
                onChange={handleNewClientChange}
                className="input"
              />
              <input
                type="tel"
                name="phone"
                placeholder="Phone"
                value={newClient.phone}
                onChange={handleNewClientChange}
                className="input"
              />
              <input
                type="text"
                name="organization"
                placeholder="Organization"
                value={newClient.organization}
                onChange={handleNewClientChange}
                className="input"
              />
              <div className="flex space-x-2">
                <button onClick={handleCreateClient} className="btn btn-primary flex-1">
                  Create Client
                </button>
                <button onClick={() => setShowNewClient(false)} className="btn btn-secondary">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Event Details */}
        <div>
          <label className="label">Event Name *</label>
          <input
            type="text"
            name="event_name"
            value={formData.event_name}
            onChange={handleInputChange}
            className="input"
            placeholder="e.g., Annual Tech Conference"
            required
          />
        </div>

        {/* Date and Time */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="label">Event Date *</label>
            <input
              type="date"
              name="event_date"
              value={formData.event_date}
              onChange={handleInputChange}
              className="input"
              min={new Date().toISOString().split('T')[0]}
              required
            />
          </div>
          <div>
            <label className="label">Start Time * (08:00-22:00)</label>
            <input
              type="time"
              name="event_start"
              value={formData.event_start}
              onChange={handleInputChange}
              className="input"
              required
            />
          </div>
          <div>
            <label className="label">End Time *</label>
            <input
              type="time"
              name="event_end"
              value={formData.event_end}
              onChange={handleInputChange}
              className="input"
              required
            />
          </div>
        </div>

        {/* Venue and Attendees */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Preferred Venue *</label>
            <select
              name="preferred_venue_id"
              value={formData.preferred_venue_id}
              onChange={handleInputChange}
              className="input"
              required
            >
              <option value="">Select preferred venue</option>
              {venues.map(venue => (
                <option key={venue.id} value={venue.id}>
                  {venue.name} - Halls: {venue.halls?.map(h => `${h.name}(${h.capacity})`).join(', ')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Expected Attendees *</label>
            <input
              type="number"
              name="attendees"
              value={formData.attendees}
              onChange={handleInputChange}
              className="input"
              min="1"
              placeholder="Number of attendees"
              required
            />
          </div>
        </div>

        {/* Resources */}
        <div>
          <h3 className="font-semibold text-gray-900 mb-3">Resource Requirements</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="label">Projectors</label>
              <input
                type="number"
                name="projectors_requested"
                value={formData.projectors_requested}
                onChange={handleInputChange}
                className="input"
                min="0"
              />
            </div>
            <div>
              <label className="label">Audio Systems</label>
              <input
                type="number"
                name="audio_systems_requested"
                value={formData.audio_systems_requested}
                onChange={handleInputChange}
                className="input"
                min="0"
              />
            </div>
            <div>
              <label className="label">Support Staff</label>
              <input
                type="number"
                name="staff_requested"
                value={formData.staff_requested}
                onChange={handleInputChange}
                className="input"
                min="0"
              />
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Note: Each event reserves the hall and resources from 30 minutes before start until 30 minutes after end.
          </p>
        </div>

        {/* Submit Button */}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary px-8"
          >
            {loading ? 'Processing...' : 'Submit Booking Request'}
          </button>
        </div>
      </form>
    </div>
  );
}
