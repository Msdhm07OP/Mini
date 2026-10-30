import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Building2,
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Command,
  FlaskConical,
  LayoutDashboard,
  Menu,
  Plus,
  Search,
  Sparkles,
  UserCheck,
  X,
} from 'lucide-react';
import Dashboard from './components/Dashboard';
import BookingForm from './components/BookingForm';
import BookingList from './components/BookingList';
import OperationsBoard from './components/OperationsBoard';
import Waitlist from './components/Waitlist';
import DecisionLog from './components/DecisionLog';
import Simulator from './components/Simulator';
import Analytics from './components/Analytics';
import StaffPortal from './components/StaffPortal';
import UserApprovals from './components/UserApprovals';
import AuthShell from './components/AuthShell';

const navGroups = [
  {
    label: 'Workspace',
    items: [
      { id: 'dashboard', name: 'Overview', icon: LayoutDashboard, description: 'A clear view of bookings and venue utilization' },
      { id: 'create', name: 'Create booking', icon: Plus, description: 'Find the right venue and reserve resources' },
      { id: 'bookings', name: 'Bookings', icon: CalendarCheck, description: 'Review, manage, and update reservations' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { id: 'operations', name: 'Operations board', icon: CalendarRange, description: 'Coordinate events across venues and halls' },
      { id: 'waitlist', name: 'Waitlist', icon: Clock3, description: 'Review requests waiting for a suitable slot' },
      { id: 'decisions', name: 'Decision log', icon: Activity, description: 'Understand allocation decisions and outcomes' },
      { id: 'staff', name: 'Staff & event orders', icon: ClipboardCheck, description: 'Prepare run-of-show notes and event checklists' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { id: 'simulator', name: 'What-if planner', icon: FlaskConical, description: 'Compare hypothetical schedules before committing' },
      { id: 'analytics', name: 'Analytics', icon: BarChart3, description: 'Explore utilization, demand, and data quality' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { id: 'users', name: 'User approvals', icon: UserCheck, description: 'Approve new registrations and manage roles' },
    ],
  },
];

const allTabs = navGroups.flatMap((group) => group.items);

function WorkspaceApp() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const activePage = allTabs.find((tab) => tab.id === activeTab) || allTabs[0];

  const filteredTabs = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) return allTabs;
    return allTabs.filter((tab) => `${tab.name} ${tab.description}`.toLowerCase().includes(query));
  }, [commandQuery]);

  const navigateTo = (tabId) => {
    setActiveTab(tabId);
    setMobileNavOpen(false);
    setCommandOpen(false);
    setCommandQuery('');
  };

  const handleBookingSuccess = () => {
    setRefreshTrigger((prev) => prev + 1);
    navigateTo('bookings');
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if (event.key === 'Escape') {
        setCommandOpen(false);
        setMobileNavOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="app-shell">
      {mobileNavOpen && <button className="mobile-nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
      <aside className={`app-sidebar ${mobileNavOpen ? 'app-sidebar-open' : ''}`} aria-label="Primary navigation">
        <div className="sidebar-brand">
          <div className="brand-symbol"><CalendarDays size={22} strokeWidth={2.3} /></div>
          <div className="brand-copy">
            <span className="brand-name">Event<span>Sync</span></span>
            <span className="brand-caption">VENUE OPERATIONS</span>
          </div>
          <button className="sidebar-mobile-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}><X size={19} /></button>
        </div>

        <button className="sidebar-create" onClick={() => navigateTo('create')}>
          <span className="sidebar-create-icon"><Plus size={18} strokeWidth={2.6} /></span>
          <span>New booking</span>
          <ArrowUpRight className="sidebar-create-arrow" size={16} />
        </button>

        <div className="sidebar-nav-scroll">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-group-label">{group.label}</p>
              <div className="nav-items">
                {group.items.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={`sidebar-nav-item ${isActive ? 'sidebar-nav-item-active' : ''}`}
                      onClick={() => navigateTo(tab.id)}
                      aria-current={isActive ? 'page' : undefined}
                      title={tab.name}
                    >
                      <span className="nav-icon-wrap"><Icon size={18} strokeWidth={isActive ? 2.35 : 1.9} /></span>
                      <span className="nav-item-name">{tab.name}</span>
                      {isActive && <span className="nav-active-dot" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="sidebar-tip-icon"><Sparkles size={16} /></div>
          <div className="sidebar-tip-copy">
            <span>Resource-aware planning</span>
            <p>Hall capacity, shared resources, and setup buffers are part of every booking.</p>
          </div>
          <div className="sidebar-bottom-rule" />
          <div className="sidebar-footnote"><ShieldCheck size={14} /><span>Built for reliable event operations</span></div>
        </div>
      </aside>

      <div className="app-main-column">
        <header className="app-topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu size={20} /></button>
            <div className="topbar-context">
              <div className="topbar-breadcrumb"><span>EventSync</span><ChevronRight size={13} /><strong>{activePage.name}</strong></div>
              <p>{activePage.description}</p>
            </div>
          </div>
          <div className="topbar-actions">
            <button className="command-search" onClick={() => setCommandOpen(true)} aria-label="Search pages">
              <Search size={16} /><span>Jump to...</span><kbd><Command size={11} /> K</kbd>
            </button>
            <div className="topbar-divider" />
            <div className="hours-chip"><span className="hours-dot" /><span>Operating hours</span><strong>08:00–22:00</strong></div>
            <button className="topbar-primary" onClick={() => navigateTo('create')}><Plus size={17} /><span>Create booking</span></button>
          </div>
        </header>

        <main className="app-main-content">
          <div className="page-transition" key={activeTab}>
            {activeTab === 'dashboard' && <Dashboard key={refreshTrigger} onCreateBooking={() => navigateTo('create')} onViewBookings={() => navigateTo('bookings')} />}
            {activeTab === 'create' && <BookingForm onSuccess={handleBookingSuccess} />}
            {activeTab === 'bookings' && <BookingList refreshTrigger={refreshTrigger} />}
            {activeTab === 'operations' && <OperationsBoard refreshTrigger={refreshTrigger} />}
            {activeTab === 'waitlist' && <Waitlist refreshTrigger={refreshTrigger} />}
            {activeTab === 'decisions' && <DecisionLog refreshTrigger={refreshTrigger} />}
            {activeTab === 'simulator' && <Simulator />}
            {activeTab === 'analytics' && <Analytics key={refreshTrigger} />}
            {activeTab === 'staff' && <StaffPortal refreshTrigger={refreshTrigger} />}
            {activeTab === 'users' && <UserApprovals refreshTrigger={refreshTrigger} />}
          </div>
          <footer className="app-footer">
            <span>EventSync <span className="footer-version">OPERATIONS SUITE</span></span>
            <span><Building2 size={13} /> Events reserve resources with 30-minute setup and cleanup buffers</span>
          </footer>
        </main>
      </div>

      {commandOpen && (
        <div className="command-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCommandOpen(false); }}>
          <section className="command-dialog" role="dialog" aria-modal="true" aria-label="Navigate EventSync">
            <div className="command-input-wrap"><Search size={19} /><input autoFocus value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="Search pages and actions..." aria-label="Search pages and actions" /><kbd>ESC</kbd></div>
            <div className="command-results-label">{commandQuery ? 'Matching destinations' : 'Quick navigation'}</div>
            <div className="command-results">
              {filteredTabs.length ? filteredTabs.map((tab) => {
                const Icon = tab.icon;
                return <button key={tab.id} className={`command-result ${activeTab === tab.id ? 'command-result-active' : ''}`} onClick={() => navigateTo(tab.id)}>
                  <span className="command-result-icon"><Icon size={17} /></span>
                  <span className="command-result-copy"><strong>{tab.name}</strong><small>{tab.description}</small></span>
                  {activeTab === tab.id ? <Check size={16} className="command-result-check" /> : <ChevronRight size={16} className="command-result-chevron" />}
                </button>;
              }) : <div className="command-empty"><Search size={20} /><span>No pages match “{commandQuery}”</span><small>Try a different search term.</small></div>}
            </div>
            <div className="command-footer"><span><kbd>↑</kbd> <kbd>↓</kbd> Search results</span><span><kbd>ESC</kbd> Close</span></div>
          </section>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return <AuthShell><WorkspaceApp /></AuthShell>;
}
