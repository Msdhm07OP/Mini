import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CheckCircle2, CreditCard, Loader2, QrCode, ShieldAlert, X } from 'lucide-react';

/**
 * Demo payment step shown after a client booking is confirmed.
 *
 * No money moves. The QR code encodes a plain-text demo reference rather than a
 * UPI or card payment link, so scanning it with a payment app cannot send funds
 * anywhere. Paid status is remembered only in this browser for the demo.
 */

const RATES = { hallPerHour: 2000, projector: 500, audio: 800, staff: 400 };
const TAX_RATE = 0.18;
const STORAGE_KEY = 'eventsync.demo.payments.v1';

const hoursBetween = (start, end) => {
  const minutes = value => { const [h, m] = String(value).split(':').map(Number); return h * 60 + m; };
  return Math.max(0, (minutes(end) - minutes(start)) / 60);
};

export function quoteFor(booking) {
  const hours = hoursBetween(booking.event_start, booking.event_end);
  const lines = [
    [`Hall hire (${hours} h × ₹${RATES.hallPerHour})`, hours * RATES.hallPerHour],
    [`Projectors (${booking.projectors_requested || 0} × ₹${RATES.projector})`, (booking.projectors_requested || 0) * RATES.projector],
    [`Audio systems (${booking.audio_systems_requested || 0} × ₹${RATES.audio})`, (booking.audio_systems_requested || 0) * RATES.audio],
    [`Support staff (${booking.staff_requested || 0} × ₹${RATES.staff})`, (booking.staff_requested || 0) * RATES.staff],
  ].filter(([, amount]) => amount > 0);
  const subtotal = lines.reduce((sum, [, amount]) => sum + amount, 0);
  const tax = Math.round(subtotal * TAX_RATE);
  return { lines, subtotal, tax, total: subtotal + tax };
}

export function readPaidBookings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}

function markPaid(bookingId, reference) {
  try {
    const paid = readPaidBookings();
    paid[bookingId] = { reference, paid_at: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(paid));
  } catch { /* Demo only: the receipt still shows even if storage is unavailable. */ }
}

const rupees = amount => `₹${amount.toLocaleString('en-IN')}`;

export default function PaymentPage({ booking, onClose, onPaid }) {
  const quote = quoteFor(booking);
  const reference = `ES-DEMO-${String(booking.id).padStart(5, '0')}`;
  const qrPayload = `EVENTSYNC DEMO PAYMENT - NOT A REAL PAYMENT\nRef: ${reference}\nEvent: ${booking.event_name}\nAmount: ${rupees(quote.total)}`;
  const [stage, setStage] = useState(readPaidBookings()[booking.id] ? 'paid' : 'pay');

  const confirmPayment = () => {
    setStage('processing');
    setTimeout(() => {
      markPaid(booking.id, reference);
      setStage('paid');
      onPaid?.();
    }, 1500);
  };

  return <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/60 p-4" role="dialog" aria-modal="true" aria-label="Payment">
    <div className="relative w-full max-w-3xl rounded-2xl bg-white shadow-2xl">
      <button className="absolute right-3 top-3 rounded-lg p-2 text-slate-400 hover:bg-slate-100" onClick={onClose} aria-label="Close"><X className="h-5 w-5" /></button>
      <div className="flex items-center gap-2 rounded-t-2xl border-b border-amber-200 bg-amber-50 px-6 py-3 text-sm text-amber-800"><ShieldAlert className="h-4 w-4 shrink-0" />Demo payment: no real money is charged.</div>

      {stage === 'paid' ? <div className="p-8 text-center">
        <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-500" />
        <h2 className="mt-4 text-2xl font-bold text-slate-900">Payment successful</h2>
        <p className="mt-1 text-slate-600">{booking.event_name} is confirmed and paid.</p>
        <div className="mx-auto mt-6 max-w-sm space-y-2 rounded-xl bg-slate-50 p-4 text-left text-sm">
          <Row label="Reference" value={reference} />
          <Row label="Amount paid" value={rupees(quote.total)} />
          <Row label="Event date" value={`${booking.event_date} · ${String(booking.event_start).slice(0, 5)}–${String(booking.event_end).slice(0, 5)}`} />
        </div>
        <button className="btn btn-primary mt-6" onClick={onClose}>Back to my bookings</button>
      </div> : <div className="grid gap-6 p-6 md:grid-cols-2">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-900"><CreditCard className="h-5 w-5 text-indigo-600" />Complete your payment</h2>
          <p className="mt-1 text-sm text-slate-500">Booking #{booking.id} · {booking.event_name}</p>
          <div className="mt-5 space-y-2 text-sm">
            {quote.lines.map(([label, amount]) => <Row key={label} label={label} value={rupees(amount)} />)}
            <div className="border-t border-slate-200 pt-2"><Row label="Subtotal" value={rupees(quote.subtotal)} /></div>
            <Row label="GST (18%)" value={rupees(quote.tax)} />
            <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900"><span>Total</span><span>{rupees(quote.total)}</span></div>
          </div>
          <button className="btn btn-primary mt-6 w-full justify-center" disabled={stage === 'processing'} onClick={confirmPayment}>
            {stage === 'processing' ? <><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Verifying payment…</> : <>I have paid {rupees(quote.total)}</>}
          </button>
          <button className="mt-2 w-full rounded-lg py-2 text-sm text-slate-500 hover:bg-slate-50" onClick={onClose}>Pay later</button>
        </div>
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-6 text-center">
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-700"><QrCode className="h-4 w-4" />Scan to pay</p>
          <div className="mt-4 rounded-xl bg-white p-4 shadow-sm"><QRCodeSVG value={qrPayload} size={200} level="M" /></div>
          <p className="mt-4 text-2xl font-bold text-slate-900">{rupees(quote.total)}</p>
          <p className="mt-1 text-xs text-slate-500">Reference {reference}</p>
          <p className="mt-3 text-xs text-slate-400">Works with any UPI app in a real deployment. This demo code contains only a text reference.</p>
        </div>
      </div>}
    </div>
  </div>;
}

function Row({ label, value }) {
  return <div className="flex justify-between gap-4 text-slate-700"><span>{label}</span><span className="font-medium text-slate-900">{value}</span></div>;
}
