/**
 * NomBlox — App Logic
 * Meal-based calorie tracking with color-coded boxes.
 */

import {
    db, auth, providers, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword,
    onAuthStateChanged, signOut, doc, getDoc, setDoc, onSnapshot, deleteDoc,
    collection, query, orderBy, limit, getDocs, sendPasswordResetEmail
} from './firebase.js';

const STATE_VERSION = 3; // bump when schema changes
const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];

const NomBlox = {

    // ── State ──────────────────────────────────────────
    state: {
        settings: {
            dailyGoal: 2000,
            increment: 50,
            theme: 'default'
        },
        currentDay: {
            date: '',
            filledBoxes: {},
            activeMeal: 'breakfast'
        },
        history: [],
        lastUpdated: 0
    },

    currentDate: '', // The date currently being viewed
    viewingDate: '', // Format: YYYY-MM-DD

    user: null,
    isSyncing: false,
    isLoggingIn: false,
    isLongPress: false,
    unsubscribeDay: null,
    unsubscribeSettings: null,
    fp: null,
    historyDates: new Set(),
    authMode: 'login', // 'login', 'signup', or 'forgot'
    _activeDayListenerDate: null, // tracks which date the day listener is subscribed to
    _historyFetchedAt: null,      // timestamp of last Firestore history fetch
    _lastSyncAt: null,            // timestamp of last startCloudSync (for visibility throttle)
    _lastSavedSettings: null,     // JSON string of settings last written to Firestore

    // ── Init ───────────────────────────────────────────
    init() {
        this.migrateLegacyData();
        this.currentDate = this.getTodayDate();
        this.viewingDate = this.currentDate;

        this.loadLocalState();
        this.renderUI();
        this.setupEventListeners();
        this.setupAuthListener();
        this.setupModalScrollLock();
        this.applyTheme();
    },

    /** Lock body scroll whenever any .modal has .active */
    setupModalScrollLock() {
        const observer = new MutationObserver(() => {
            const anyOpen = document.querySelector('.modal.active');
            document.body.classList.toggle('modal-open', !!anyOpen);
        });
        document.querySelectorAll('.modal').forEach(modal => {
            observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
        });
    },

    migrateLegacyData() {
        if (localStorage.getItem('box-cal-settings') && !localStorage.getItem('nomblox-settings')) {
            console.log("Migrating legacy Box-Cal data to NomBlox...");
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith('box-cal-')) {
                    const newKey = key.replace('box-cal-', 'nomblox-');
                    localStorage.setItem(newKey, localStorage.getItem(key));
                }
            });
        }
    },

    setupAuthListener() {
        onAuthStateChanged(auth, (user) => {
            this.user = user;
            this.updateSyncUI();

            if (user) {
                console.log("Auth state changed: User logged in", user.email);
                this.startCloudSync();
                this.fetchHistory(true); // Load history once on login
                document.getElementById('auth-modal').classList.remove('active');
            } else {
                console.log("Auth state changed: User logged out");
                // Unsubscribe all listeners and reset tracking state on logout
                if (this.unsubscribeDay) { this.unsubscribeDay(); this.unsubscribeDay = null; }
                if (this.unsubscribeSettings) { this.unsubscribeSettings(); this.unsubscribeSettings = null; }
                this._activeDayListenerDate = null;
                this._historyFetchedAt = null;
                this._lastSavedSettings = null;
                this._lastSyncAt = null;
                // Clear local data on logout to ensure no data leaks between accounts
                this.clearLocalData();
                this.renderUI();
            }
        });
    },

    // ── Persistence ────────────────────────────────────
    loadLocalState() {
        // 1. Load Settings
        const savedSettings = localStorage.getItem('nomblox-settings');
        if (savedSettings) {
            try {
                this.state.settings = JSON.parse(savedSettings);
            } catch (e) { console.error("Error loading settings", e); }
        }

        // 2. Load History
        const savedHistory = localStorage.getItem('nomblox-history');
        if (savedHistory) {
            try {
                this.state.history = JSON.parse(savedHistory);
                this.updateHistoryDates();
            } catch (e) { console.error("Error loading history", e); }
        }

        // 3. Load Current Viewing Day
        this.loadDay(this.viewingDate);
    },

    loadDay(date) {
        const key = `nomblox-day-${date}`;
        const savedDay = localStorage.getItem(key);

        if (savedDay) {
            try {
                this.state.currentDay = JSON.parse(savedDay);
                // Ensure the date property is correctly set to what we requested
                this.state.currentDay.date = date;
            } catch (e) {
                console.error("Error loading day data", e);
                this.state.currentDay = { date: date, filledBoxes: {}, activeMeal: 'breakfast' };
            }
        } else {
            this.state.currentDay = { date: date, filledBoxes: {}, activeMeal: 'breakfast' };
        }

        // Ensure some sanity
        if (!this.state.currentDay.filledBoxes) this.state.currentDay.filledBoxes = {};
        if (!this.state.currentDay.activeMeal) this.state.currentDay.activeMeal = 'breakfast';
    },

    saveLocalState(skipTimestamp = false) {
        if (!skipTimestamp) {
            this.state.lastUpdated = Date.now();
        }

        // Save settings
        localStorage.setItem('nomblox-settings', JSON.stringify(this.state.settings));

        // CRITICAL: viewingDate is the single source of truth for which day slot we write to.
        // Always force currentDay.date to match before saving, preventing ghost documents.
        const saveDate = this.viewingDate;
        this.state.currentDay.date = saveDate;
        // Only stamp the day's own timestamp when this is a NEW local change.
        // When skipTimestamp=true (sync-triggered saves), we must NOT overwrite the day's
        // timestamp or it poisons the day listener's cloudData > localDay comparison,
        // causing remote day updates to be silently ignored ("leapfrog bug").
        if (!skipTimestamp) {
            this.state.currentDay.lastUpdated = this.state.lastUpdated;
        }

        const dayKey = `nomblox-day-${saveDate}`;
        localStorage.setItem(dayKey, JSON.stringify(this.state.currentDay));
        localStorage.setItem('nomblox-last-updated', this.state.lastUpdated);

        // Save history (cache)
        localStorage.setItem('nomblox-history', JSON.stringify(this.state.history));

        // Update history dates for calendar dots
        const count = Object.keys(this.state.currentDay.filledBoxes).length;
        if (this.fp) this.fp.redraw();

        // Update in-memory history for stats/history modal consistency
        this.updateHistoryEntry(saveDate, count);

        // Legacy support / overall metadata
        localStorage.setItem('nomblox-last-updated', this.state.lastUpdated);
    },

    /** Update a single entry in the history array without a full re-fetch */
    updateHistoryEntry(date, boxCount) {
        const calories = boxCount * this.state.settings.increment;
        const index = this.state.history.findIndex(h => h.date === date);

        // Update history dates for calendar dots
        if (calories > 0) {
            this.historyDates.add(date);
        } else {
            this.historyDates.delete(date);
        }
        if (this.fp) this.fp.redraw();

        // Update calorie count in history array
        if (index !== -1) {
            this.state.history[index].calories = calories;
        } else if (calories > 0) {
            this.state.history.push({
                date: date,
                calories: calories,
                meals: {}
            });
            this.state.history.sort((a, b) => b.date.localeCompare(a.date));
        }
    },

    async saveState() {
        this.saveLocalState();

        if (this.user && !this.isSyncing) {
            // Snapshot viewingDate at the time of call so async doesn't race with date navigation
            const saveDate = this.viewingDate;
            if (!saveDate) {
                console.warn('saveState: no date available, skipping cloud save');
                return;
            }

            try {
                // Always write lastUpdated to the user doc so other devices'
                // settings listeners have a current timestamp to compare against.
                // Only include the settings payload when it actually changed.
                const settingsJson = JSON.stringify(this.state.settings);
                const settingsChanged = settingsJson !== this._lastSavedSettings;
                if (settingsChanged) this._lastSavedSettings = settingsJson;

                await setDoc(doc(db, "users", this.user.uid), {
                    ...(settingsChanged ? { settings: this.state.settings } : {}),
                    lastUpdated: this.state.lastUpdated
                }, { merge: true });

                // Always save the current day doc
                const dayRef = doc(db, "users", this.user.uid, "days", saveDate);
                await setDoc(dayRef, {
                    ...this.state.currentDay,
                    date: saveDate,
                    lastUpdated: this.state.lastUpdated
                });
            } catch (e) {
                console.error("Error saving to cloud:", e);
            }
        }
    },

    startCloudSync() {
        // Fix #1: Settings listener is created once at login and never torn down until logout.
        // Re-creating it on every date navigation was billing a read on every subscription.
        if (!this.unsubscribeSettings) {
            this.setupSettingsListener();
        }
        // Day listener is only recreated when the viewed date actually changes.
        this.startDaySync(this.viewingDate);
        this.isLoggingIn = false;
    },

    handleRemoteWipe(cloudWipedAt) {
        const lastSeenWipe = parseInt(localStorage.getItem('nomblox-wiped-at') || '0', 10);
        if (cloudWipedAt > lastSeenWipe) {
            console.log('Remote wipe detected — resetting local state.');

            // Prevent any outgoing saves while we are wiping
            this.isSyncing = true;

            localStorage.setItem('nomblox-wiped-at', cloudWipedAt);
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith('nomblox-') && key !== 'nomblox-wiped-at') {
                    localStorage.removeItem(key);
                }
            });

            // Force a clean state before reload just in case
            this.state.currentDay = { date: this.getTodayDate(), filledBoxes: {}, activeMeal: 'breakfast' };
            this.state.history = [];

            location.reload();
            return true;
        }
        return false;
    },

    // Fix #1: Replaced setupSyncListeners with two dedicated methods.
    // startDaySync: recreated only when the viewed date changes.
    // setupSettingsListener: created once at login, never torn down until logout.

    startDaySync(date) {
        // No-op if already subscribed to this exact date — avoids a billed read
        if (this._activeDayListenerDate === date) return;

        if (this.unsubscribeDay) this.unsubscribeDay();
        this._activeDayListenerDate = date;

        const dayRef = doc(db, "users", this.user.uid, "days", date);
        const listenerDate = date;
        console.log(`Setting up day listener for: ${listenerDate}`);

        this.unsubscribeDay = onSnapshot(dayRef, (snap) => {
            if (snap.metadata.hasPendingWrites) return;

            // If the user has navigated away, ignore to prevent cross-date overwrites
            if (this.viewingDate !== listenerDate) {
                console.log(`Ignoring stale day snapshot for ${listenerDate} (now viewing ${this.viewingDate})`);
                return;
            }

            if (snap.exists()) {
                const cloudData = snap.data();
                const localKey = `nomblox-day-${listenerDate}`;
                const localDayRaw = localStorage.getItem(localKey);
                const localDay = localDayRaw ? JSON.parse(localDayRaw) : null;

                if (!localDay || (cloudData.lastUpdated || 0) > (localDay.lastUpdated || 0)) {
                    console.log(`Remote day update received for ${listenerDate}`);
                    this.isSyncing = true;
                    try {
                        this.state.currentDay = { ...cloudData, date: listenerDate };
                        this.saveLocalState(true);
                        this.renderUI();
                    } catch (e) {
                        console.error("Error applying remote day update:", e);
                    } finally {
                        this.isSyncing = false;
                    }
                } else if (localDay && (localDay.lastUpdated || 0) > (cloudData.lastUpdated || 0)) {
                    console.log(`Local day is newer for ${listenerDate} — pushing to cloud.`);
                    setDoc(dayRef, { ...localDay, date: listenerDate });
                }
            } else {
                const localKey = `nomblox-day-${listenerDate}`;
                const localDayRaw = localStorage.getItem(localKey);
                if (localDayRaw) {
                    try {
                        const localDay = JSON.parse(localDayRaw);
                        const lastWipe = parseInt(localStorage.getItem('nomblox-wiped-at') || '0', 10);
                        if ((localDay.lastUpdated || 0) > lastWipe) {
                            console.log(`Cloud missing day ${listenerDate} — pushing local data.`);
                            setDoc(dayRef, { ...localDay, date: listenerDate });
                        }
                    } catch (e) { console.error("Error parsing local day:", e); }
                }
            }
        }, (error) => {
            console.error(`Day listener error for ${listenerDate}:`, error);
        });
    },

    setupSettingsListener() {
        const userRef = doc(db, "users", this.user.uid);
        console.log('Setting up settings listener (one-time until logout)');

        this.unsubscribeSettings = onSnapshot(userRef, (snap) => {
            if (snap.metadata.hasPendingWrites) return;
            if (!snap.exists()) return;
            const cloudData = snap.data();

            // ── Remote wipe detection ──────────────────────────────────────
            if (cloudData.wipedAt && this.handleRemoteWipe(cloudData.wipedAt)) return;
            // ──────────────────────────────────────────────────────────────

            if (cloudData.settings && (cloudData.lastUpdated || 0) > (this.state.lastUpdated || 0)) {
                console.log("Remote settings update received");
                this.isSyncing = true;
                try {
                    this.state.settings = { ...this.state.settings, ...cloudData.settings };
                    this.state.lastUpdated = cloudData.lastUpdated;
                    // Keep the settings write-dedup cache in sync with what's on the server
                    this._lastSavedSettings = JSON.stringify(this.state.settings);
                    this.saveLocalState(true);
                    this.renderUI();
                } catch (e) {
                    console.error("Error applying remote settings update:", e);
                } finally {
                    this.isSyncing = false;
                }
            }
        }, (error) => {
            console.error("Settings listener error:", error);
        });
    },

    // Removed isDifferent and mergeStates in favor of per-day timestamped sync.

    // Removed old setupRealtimeSync in favor of setupSyncListeners

    showConflictModal(serverData) {
        const modal = document.getElementById('conflict-modal');
        const useServerBtn = document.getElementById('use-server-btn');
        const useLocalBtn = document.getElementById('use-local-btn');
        const logoutBtn = document.getElementById('conflict-logout');

        const localUpdatedEl = document.getElementById('local-updated');
        const serverUpdatedEl = document.getElementById('server-updated');
        const localOption = document.getElementById('local-conflict-option');
        const serverOption = document.getElementById('server-conflict-option');

        const formatTime = (ts) => {
            if (!ts) return 'Never';
            return new Date(ts).toLocaleString([], {
                month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
        };

        const localTs = this.state.lastUpdated || 0;
        const serverTs = serverData.lastUpdated || 0;

        localUpdatedEl.textContent = `Last updated: ${formatTime(localTs)}`;
        serverUpdatedEl.textContent = `Last updated: ${formatTime(serverTs)}`;

        // Highlight newest
        localOption.classList.remove('newest');
        serverOption.classList.remove('newest');

        if (localTs > serverTs) {
            localOption.classList.add('newest');
        } else if (serverTs > localTs) {
            serverOption.classList.add('newest');
        }

        const handleChoice = async (useServer) => {
            modal.classList.remove('active');
            if (useServer) {
                this.state = serverData;
                this.saveLocalState(true);
            } else {
                // Keep local, push to server
                await this.saveState();
            }
            this.renderUI();
            this.startCloudSync(); // Fix #5: was calling removed setupRealtimeSync
        };

        const handleLogout = async () => {
            modal.classList.remove('active');
            this.clearLocalData();
            await signOut(auth);
            location.reload();
        };

        useServerBtn.onclick = () => handleChoice(true);
        useLocalBtn.onclick = () => handleChoice(false);
        logoutBtn.onclick = handleLogout;

        modal.classList.add('active');
    },

    async handleSync() {
        if (this.user) {
            const email = this.user.email || "Anonymous";
            this.showConfirm(
                "Logout",
                `Logged in as ${email}\n\nDo you want to log out?`,
                async () => {
                    this.clearLocalData();
                    await signOut(auth);
                    location.reload();
                }
            );
        } else {
            this.showAuthError(''); // Clear previous errors
            this.authMode = 'login';
            this.updateAuthUI();
            document.getElementById('auth-email').value = '';
            document.getElementById('auth-password').value = '';
            document.getElementById('auth-confirm-password').value = '';
            document.getElementById('auth-modal').classList.add('active');
        }
    },

    showAuthError(msg) {
        const errorEl = document.getElementById('auth-error');
        if (!errorEl) return;

        if (msg) {
            errorEl.textContent = msg;
            errorEl.style.display = 'block';
        } else {
            errorEl.style.display = 'none';
        }
    },

    async handleEmailLogin() {
        if (this.authMode === 'forgot') {
            await this.handleForgotPassword();
            return;
        }

        const isSignup = this.authMode === 'signup';
        this.isLoggingIn = true;
        const email = document.getElementById('auth-email').value;
        const pass = document.getElementById('auth-password').value;
        const confirmPass = document.getElementById('auth-confirm-password').value;

        if (!email || !pass) { this.showAuthError('Please enter email and password.'); return; }
        if (isSignup && !confirmPass) { this.showAuthError('Please confirm your password.'); return; }
        if (isSignup && pass !== confirmPass) { this.showAuthError('Passwords do not match.'); return; }
        if (pass.length < 6) { this.showAuthError('Password must be at least 6 characters.'); return; }

        this.showAuthError('');

        try {
            if (isSignup) {
                await createUserWithEmailAndPassword(auth, email, pass);
            } else {
                await signInWithEmailAndPassword(auth, email, pass);
            }
        } catch (e) {
            console.error("Auth failed:", e);
            let msg = e.message;
            if (e.code === 'auth/invalid-credential') msg = "Invalid email or password.";
            if (e.code === 'auth/email-already-in-use') msg = "Email already in use.";
            if (e.code === 'auth/weak-password') msg = "Password is too weak.";
            this.showAuthError(msg);
        }
    },

    async handleForgotPassword() {
        const email = document.getElementById('auth-email').value;
        if (!email) {
            this.showAuthError('Please enter your email address first.');
            return;
        }

        try {
            await sendPasswordResetEmail(auth, email);
            this.showAuthError('Password reset email sent! Check your inbox.');
        } catch (e) {
            console.error("Reset failed:", e);
            let msg = e.message;
            if (e.code === 'auth/user-not-found') msg = "No account found with this email.";
            this.showAuthError(msg);
        }
    },

    toggleAuthMode() {
        if (this.authMode === 'forgot') {
            this.authMode = 'login';
        } else {
            this.authMode = this.authMode === 'login' ? 'signup' : 'login';
        }
        this.updateAuthUI();
    },

    updateAuthUI() {
        const isSignup = this.authMode === 'signup';
        const isForgot = this.authMode === 'forgot';

        const submitBtn = document.getElementById('auth-submit-btn');
        const toggleBtn = document.getElementById('auth-toggle-btn');
        const toggleText = document.getElementById('auth-toggle-text');
        const confirmGroup = document.getElementById('confirm-password-group');
        const forgotPasswordContainer = document.getElementById('forgot-password-container');
        const passwordInput = document.getElementById('auth-password');
        const passwordGroup = passwordInput ? passwordInput.closest('.form-group') : null;
        const googleBtn = document.getElementById('login-google');
        const authDivider = document.getElementById('auth-divider');

        if (isForgot) {
            if (submitBtn) submitBtn.textContent = 'Send Reset Link';
            if (toggleBtn) toggleBtn.textContent = 'Back to Login';
            if (toggleText) toggleText.textContent = '';
            if (passwordGroup) passwordGroup.style.display = 'none';
            if (confirmGroup) confirmGroup.style.display = 'none';
            if (forgotPasswordContainer) forgotPasswordContainer.style.display = 'none';
            if (googleBtn) googleBtn.style.display = 'none';
            if (authDivider) authDivider.style.display = 'none';
        } else {
            if (passwordGroup) passwordGroup.style.display = 'block';
            if (googleBtn) googleBtn.style.display = 'flex';
            if (authDivider) authDivider.style.display = 'flex';
            if (submitBtn) submitBtn.textContent = isSignup ? 'Create Account' : 'Login';
            if (toggleBtn) toggleBtn.textContent = isSignup ? 'Login' : 'Sign Up';
            if (toggleText) toggleText.textContent = isSignup ? 'Already have an account?' : "Don't have an account?";

            if (confirmGroup) {
                confirmGroup.style.display = isSignup ? 'block' : 'none';
            }

            if (forgotPasswordContainer) {
                forgotPasswordContainer.style.display = isSignup ? 'none' : 'block';
            }
        }

        this.showAuthError(''); // Clear errors when switching
    },

    updateSyncUI() {
        const btn = document.getElementById('sync-btn');
        const settingsUserInfo = document.getElementById('settings-user-info');
        const footerUserInfo = document.getElementById('footer-user-info');
        if (!btn) return;

        // Clear existing icon or image
        btn.innerHTML = '';

        if (this.user) {
            btn.classList.add('active');
            btn.setAttribute('aria-label', `Logged in as ${this.user.email}`);

            if (this.user.photoURL) {
                const img = document.createElement('img');
                img.src = this.user.photoURL;
                img.className = 'user-avatar';
                img.alt = 'User Avatar';
                btn.appendChild(img);
            } else {
                const icon = document.createElement('i');
                icon.setAttribute('data-lucide', 'user');
                btn.appendChild(icon);
            }

            if (settingsUserInfo) {
                const email = this.user.email || 'Cloud User';
                settingsUserInfo.innerHTML = `<i data-lucide="user"></i><span>${email}</span>`;
                settingsUserInfo.style.display = 'flex';
            }
            if (footerUserInfo) {
                footerUserInfo.textContent = `Logged in as ${this.user.email}`;
            }
        } else {
            btn.classList.remove('active');
            const icon = document.createElement('i');
            icon.setAttribute('data-lucide', 'user'); // Changed from cloud-off to user
            btn.appendChild(icon);
            btn.setAttribute('aria-label', 'Login / Sync');

            if (settingsUserInfo) {
                settingsUserInfo.style.display = 'none';
            }
            if (footerUserInfo) {
                footerUserInfo.textContent = '';
            }
        }

        if (typeof lucide !== 'undefined') lucide.createIcons();
    },

    clearLocalData() {
        console.log("Clearing all local data...");
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('nomblox-')) {
                localStorage.removeItem(key);
            }
        });
        // Reset in-memory state to defaults
        this.state = {
            settings: { dailyGoal: 2000, increment: 50 },
            currentDay: { date: this.getTodayDate(), filledBoxes: {}, activeMeal: 'breakfast' },
            history: [],
            lastUpdated: 0
        };
        this.historyDates = new Set();
        // Reset fetch-tracking state so the next login starts fresh
        this._historyFetchedAt = null;
        this._lastSavedSettings = null;
    },

    getTodayDate() {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    },

    // Removed checkDailyReset as per-day storage handles it naturally.

    async handleDebugData() {
        if (!this.user) {
            alert("Please log in to see server data.");
            return;
        }

        const debugModal = document.getElementById('debug-modal');
        const output = document.getElementById('debug-output');
        output.textContent = "Fetching data from server...";
        debugModal.classList.add('active');

        try {
            const userRef = doc(db, "users", this.user.uid);
            const userSnap = await getDoc(userRef);

            const daysRef = collection(db, "users", this.user.uid, "days");
            const daysSnap = await getDocs(query(daysRef, orderBy("date", "desc"), limit(10)));

            const serverData = {
                user: userSnap.exists() ? userSnap.data() : "No user doc",
                recentDays: []
            };

            daysSnap.forEach(doc => {
                serverData.recentDays.push(doc.data());
            });

            output.textContent = JSON.stringify(serverData, null, 2);
        } catch (e) {
            output.textContent = "Error fetching data: " + e.message;
        }
    },

    backupData() {
        const backup = {
            version: STATE_VERSION,
            timestamp: Date.now(),
            data: {}
        };

        // Collect all box-cal items from localStorage
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('nomblox-')) {
                backup.data[key] = localStorage.getItem(key);
            }
        }

        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const date = new Date().toISOString().split('T')[0];

        a.href = url;
        a.download = `nomblox-backup-${date}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    restoreData() {
        const input = document.getElementById('restore-input');
        input.click();
    },

    handleRestoreFile(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const backup = JSON.parse(event.target.result);

                // Basic validation
                if (!backup.data || typeof backup.data !== 'object') {
                    throw new Error("Invalid backup format: Missing data object.");
                }

                this.showConfirm(
                    'Restore Data',
                    'This will OVERWRITE all your current local data with the data from this backup. Are you sure?',
                    async () => {
                        // Clear current box-cal keys
                        const keysToRemove = [];
                        for (let i = 0; i < localStorage.length; i++) {
                            const key = localStorage.key(i);
                            if (key.startsWith('nomblox-')) {
                                keysToRemove.push(key);
                            }
                        }
                        keysToRemove.forEach(k => localStorage.removeItem(k));

                        // Restore from backup and update timestamps to ensure it's seen as "newest"
                        const newSyncTime = Date.now();
                        for (let [key, value] of Object.entries(backup.data)) {
                            // Skip the old wiped-at and last-updated keys from the backup, 
                            // we will set them to the current time.
                            if (key === 'nomblox-wiped-at' || key === 'nomblox-last-updated') continue;

                            // Update timestamps for each day record
                            if (key.startsWith('nomblox-day-')) {
                                try {
                                    const dayObj = JSON.parse(value);
                                    dayObj.lastUpdated = newSyncTime;
                                    value = JSON.stringify(dayObj);
                                } catch (e) {
                                    console.warn("Failed to update timestamp for day key:", key);
                                }
                            }
                            localStorage.setItem(key, value);
                        }

                        // Force global timestamps to current time
                        // We set wiped-at slightly BEFORE the current time to ensure 
                        // day.lastUpdated (newSyncTime) is strictly greater than wiped-at.
                        localStorage.setItem('nomblox-last-updated', newSyncTime);
                        localStorage.setItem('nomblox-wiped-at', newSyncTime - 1000);

                        location.reload();
                    }
                );
            } catch (err) {
                console.error("Restore failed:", err);
                alert("Failed to restore: " + err.message);
            }
            // Reset input so the same file can be selected again
            e.target.value = '';
        };
        reader.readAsText(file);
    },

    async deleteAllData() {
        this.showConfirm(
            'Wipe All Data',
            'This will PERMANENTLY delete all calorie logs from every day. Your account and settings will remain. This cannot be undone.',
            async () => {
                const wipedAt = Date.now();
                this.isSyncing = true; // Block normal sync during wipe

                // 1. Clear Cloud Data (if logged in)
                if (this.user) {
                    try {
                        // CRITICAL: Set local wipe timestamp FIRST so our own listener doesn't 
                        // trigger a reload when we update the user document.
                        localStorage.setItem('nomblox-wiped-at', wipedAt);

                        // Signal all other devices to wipe immediately
                        await setDoc(doc(db, "users", this.user.uid), {
                            lastUpdated: wipedAt,
                            wipedAt: wipedAt
                        }, { merge: true });

                        const daysRef = collection(db, "users", this.user.uid, "days");
                        const daysSnap = await getDocs(daysRef);

                        // Fix #6: Delete in chunks of 500 to respect Firestore limits
                        const allDocs = daysSnap.docs;
                        for (let i = 0; i < allDocs.length; i += 500) {
                            await Promise.all(allDocs.slice(i, i + 500).map(d => deleteDoc(d.ref)));
                        }
                    } catch (e) {
                        console.error("Error wiping cloud days:", e);
                        alert("Failed to wipe some cloud data. Check console.");
                    }
                }

                // 2. Clear Local Storage
                Object.keys(localStorage).forEach(key => {
                    if (key.startsWith('nomblox-') && key !== 'nomblox-wiped-at') {
                        localStorage.removeItem(key);
                    }
                });

                // Ensure wipedAt is definitely set (it was set above, but just in case of non-user mode)
                localStorage.setItem('nomblox-wiped-at', wipedAt);

                // 3. Reload (Stay logged in)
                location.reload();
            }
        );
    },

    copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('copy-debug');
            const originalText = btn.textContent;
            btn.textContent = "Copied!";
            setTimeout(() => btn.textContent = originalText, 2000);
        }).catch(err => {
            console.error('Could not copy text: ', err);
        });
    },

    async fetchHistory(force = false) {
        if (!this.user) {
            // Still render stats panel with local history data
            this.renderStatsPanel();
            return;
        }

        // Fix #2: Use a 60-second TTL so the stats modal serves from the local
        // state.history cache instead of querying Firestore on every open.
        // state.history is kept up-to-date by updateHistoryEntry() on every box click.
        const STALE_MS = 60_000;
        const isFresh = this._historyFetchedAt && (Date.now() - this._historyFetchedAt < STALE_MS);
        if (!force && isFresh && this.state.history.length > 0) {
            this.renderStatsPanel();
            return;
        }

        // Render immediately with cached data while the cloud fetch runs in the background
        if (this.state.history.length > 0) {
            this.renderStatsPanel();
        }

        try {
            const daysRef = collection(db, "users", this.user.uid, "days");
            // Fix #7: limit(500) is a documented safety cap.
            // Users with more than 500 tracked days will see their most recent 500.
            const q = query(daysRef, orderBy("date", "desc"), limit(500));
            const querySnapshot = await getDocs(q);

            const lastWipe = parseInt(localStorage.getItem('nomblox-wiped-at') || '0', 10);
            const historyMap = new Map();
            querySnapshot.forEach((doc) => {
                const data = doc.data();

                // If this data was updated before the last wipe, ignore it (likely cached stale data)
                if (lastWipe > 0 && (data.lastUpdated || 0) <= lastWipe) return;

                const date = data.date || doc.id; // Use document ID as fallback
                const filledBoxes = data.filledBoxes || {};
                const inc = this.state.settings.increment || 50;

                // Per-meal calorie counts
                const meals = { breakfast: 0, lunch: 0, dinner: 0, snacks: 0 };
                Object.values(filledBoxes).forEach(meal => {
                    if (meals[meal] !== undefined) meals[meal] += inc;
                });

                const totalCals = Object.values(meals).reduce((a, b) => a + b, 0);

                const existing = historyMap.get(date);
                if (!existing || (data.lastUpdated || 0) > (existing._lastUpdated || 0)) {
                    historyMap.set(date, {
                        date: date,
                        calories: totalCals,
                        meals: meals,
                        _lastUpdated: data.lastUpdated || 0
                    });
                }
            });

            // Convert map to sorted array (desc by date)
            const history = Array.from(historyMap.values())
                .map(({ _lastUpdated, ...rest }) => rest) // Strip internal field
                .sort((a, b) => b.date.localeCompare(a.date));

            // Always update state, even if history is empty (e.g. after a wipe)
            this.state.history = history;
            this.updateHistoryDates();
            this.saveLocalState(true);
            this._historyFetchedAt = Date.now(); // Mark cache as fresh

            this.renderStatsPanel();
        } catch (e) {
            console.error("Error fetching history:", e);
            this.renderStatsPanel(); // Render with local data even if fetch fails
        }
    },

    updateHistoryDates() {
        this.historyDates = new Set(this.state.history.filter(h => h.calories > 0).map(h => h.date));
        if (this.fp) this.fp.redraw();
    },

    statsChart: null,
    statsRange: 7,

    getFilteredHistory() {
        const sorted = [...this.state.history].sort((a, b) => a.date.localeCompare(b.date));
        if (this.statsRange === 'all') return sorted;

        // Filter by actual calendar days, not entry count
        const today = new Date(this.getTodayDate() + 'T12:00:00');
        const cutoff = new Date(today);
        cutoff.setDate(cutoff.getDate() - this.statsRange);
        const cutoffStr = cutoff.toISOString().split('T')[0];

        return sorted.filter(h => h.date >= cutoffStr);
    },

    renderStatsPanel() {
        const filtered = this.getFilteredHistory();

        this.renderStatsOverview(filtered);
        this.renderStatsChart(filtered);
        this.renderMealBreakdown(filtered);
        this.renderStatsRecords(filtered);
        this.renderHistory();
        this.setupRangeToggle();

        if (typeof lucide !== 'undefined') lucide.createIcons();
    },

    renderStatsOverview(history) {
        const totalCals = history.reduce((sum, h) => sum + h.calories, 0);
        const daysTracked = history.filter(h => h.calories > 0).length;
        const avgDaily = daysTracked > 0 ? Math.round(totalCals / daysTracked) : 0;
        const streak = this.calculateStreak(history);

        document.getElementById('stat-total-cals').textContent = totalCals.toLocaleString();
        document.getElementById('stat-days-tracked').textContent = daysTracked.toLocaleString();
        document.getElementById('stat-avg-daily').textContent = avgDaily.toLocaleString();
        document.getElementById('stat-streak').textContent = streak;
    },

    calculateStreak(history) {
        if (history.length === 0) return 0;

        // Sort by date descending
        const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
        let streak = 0;
        const today = this.getTodayDate();
        let checkDate = new Date(today + 'T12:00:00');

        for (const entry of sorted) {
            const entryDate = entry.date;
            const expected = checkDate.toISOString().split('T')[0];

            if (entryDate === expected && entry.calories > 0) {
                streak++;
                checkDate.setDate(checkDate.getDate() - 1);
            } else if (entryDate < expected) {
                // Gap found
                break;
            }
        }

        return streak;
    },

    renderStatsChart(history) {
        const canvas = document.getElementById('stats-chart');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');

        // Destroy previous chart if exists
        if (this.statsChart) {
            this.statsChart.destroy();
            this.statsChart = null;
        }

        // history is already filtered and sorted ascending by caller
        const filtered = history;

        if (filtered.length === 0) {
            this.statsChart = null;
            // Clear the canvas if no data
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }

        const labels = filtered.map(h => {
            const d = new Date(h.date + 'T12:00:00');
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        });

        const calData = filtered.map(h => h.calories);
        const goal = this.state.settings.dailyGoal;
        const goalLine = filtered.map(() => goal);

        // Color styling
        const accentRgb = '102, 178, 229'; // hsl(200, 85%, 55%) approximation
        const dangerRgb = '234, 142, 65';  // dinner orange

        this.statsChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Calories',
                        data: calData,
                        borderColor: `rgba(${accentRgb}, 1)`,
                        backgroundColor: (context) => {
                            const chart = context.chart;
                            const { ctx: c, chartArea } = chart;
                            if (!chartArea) return `rgba(${accentRgb}, 0.1)`;
                            const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                            gradient.addColorStop(0, `rgba(${accentRgb}, 0.25)`);
                            gradient.addColorStop(1, `rgba(${accentRgb}, 0.02)`);
                            return gradient;
                        },
                        borderWidth: 2.5,
                        fill: true,
                        tension: 0.35,
                        pointRadius: filtered.length > 14 ? 0 : 4,
                        pointHoverRadius: 6,
                        pointBackgroundColor: `rgba(${accentRgb}, 1)`,
                        pointBorderColor: 'rgba(255,255,255,0.9)',
                        pointBorderWidth: 2,
                    },
                    {
                        label: 'Goal',
                        data: goalLine,
                        borderColor: `rgba(${dangerRgb}, 0.5)`,
                        borderWidth: 1.5,
                        borderDash: [6, 4],
                        fill: false,
                        tension: 0,
                        pointRadius: 0,
                        pointHoverRadius: 0,
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'hsl(220, 25%, 12%)',
                        titleColor: 'hsl(0, 0%, 98%)',
                        bodyColor: 'hsl(220, 10%, 60%)',
                        borderColor: 'hsla(0, 0%, 100%, 0.08)',
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 10,
                        titleFont: { family: 'Outfit', weight: '700', size: 13 },
                        bodyFont: { family: 'Outfit', size: 12 },
                        displayColors: false,
                        callbacks: {
                            label: (ctx) => {
                                if (ctx.datasetIndex === 0) return `${ctx.parsed.y.toLocaleString()} cal`;
                                return `Goal: ${ctx.parsed.y.toLocaleString()}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: {
                            color: 'hsl(220, 10%, 40%)',
                            font: { family: 'Outfit', size: 10, weight: '600' },
                            maxTicksLimit: 7,
                            maxRotation: 0
                        },
                        grid: { display: false },
                        border: { display: false }
                    },
                    y: {
                        ticks: {
                            color: 'hsl(220, 10%, 40%)',
                            font: { family: 'Outfit', size: 10, weight: '600' },
                            callback: (val) => val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val,
                            maxTicksLimit: 5
                        },
                        grid: {
                            color: 'hsla(0, 0%, 100%, 0.04)',
                            drawTicks: false
                        },
                        border: { display: false },
                        beginAtZero: true
                    }
                }
            }
        });
    },

    renderMealBreakdown(history) {
        const container = document.getElementById('meal-breakdown-bars');
        if (!container) return;

        const daysWithData = history.filter(h => h.calories > 0);
        const count = daysWithData.length || 1;

        const totals = { breakfast: 0, lunch: 0, dinner: 0, snacks: 0 };
        daysWithData.forEach(h => {
            if (h.meals) {
                MEALS.forEach(m => { totals[m] += (h.meals[m] || 0); });
            }
        });

        const averages = {};
        MEALS.forEach(m => { averages[m] = Math.round(totals[m] / count); });
        const maxAvg = Math.max(...Object.values(averages), 1);

        const mealColors = {
            breakfast: 'var(--breakfast)',
            lunch: 'var(--lunch)',
            dinner: 'var(--dinner)',
            snacks: 'var(--snacks)'
        };

        const mealLabels = {
            breakfast: 'Bfast',
            lunch: 'Lunch',
            dinner: 'Dinner',
            snacks: 'Snacks'
        };

        container.innerHTML = MEALS.map(meal => {
            const pct = Math.round((averages[meal] / maxAvg) * 100);
            return `
                <div class="meal-bar-row">
                    <div class="meal-bar-label">
                        <span class="meal-bar-dot" style="background:${mealColors[meal]};box-shadow:0 0 6px ${mealColors[meal]};"></span>
                        ${mealLabels[meal]}
                    </div>
                    <div class="meal-bar-track">
                        <div class="meal-bar-fill" style="width:${pct}%;background:${mealColors[meal]};box-shadow:0 0 8px ${mealColors[meal]}44;"></div>
                    </div>
                    <span class="meal-bar-value">${averages[meal].toLocaleString()}</span>
                </div>
            `;
        }).join('');
    },

    renderStatsRecords(history) {
        const goal = this.state.settings.dailyGoal;
        const withData = history.filter(h => h.calories > 0);

        const formatDate = (dateStr) => {
            const d = new Date(dateStr + 'T12:00:00');
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        };

        if (withData.length === 0) {
            document.getElementById('stat-best-day').textContent = '—';
            document.getElementById('stat-worst-day').textContent = '—';
            document.getElementById('stat-under-goal').textContent = '—';
            return;
        }

        const best = withData.reduce((a, b) => a.calories > b.calories ? a : b);
        const worst = withData.reduce((a, b) => a.calories < b.calories ? a : b);
        const underGoalCount = withData.filter(h => h.calories <= goal).length;
        const underGoalPct = Math.round((underGoalCount / withData.length) * 100);

        document.getElementById('stat-best-day').textContent = `${best.calories.toLocaleString()} cal · ${formatDate(best.date)}`;
        document.getElementById('stat-worst-day').textContent = `${worst.calories.toLocaleString()} cal · ${formatDate(worst.date)}`;
        document.getElementById('stat-under-goal').textContent = `${underGoalPct}% (${underGoalCount}/${withData.length} days)`;
    },

    setupRangeToggle() {
        const buttons = document.querySelectorAll('.range-btn');
        buttons.forEach(btn => {
            // Remove old listeners by cloning
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);

            newBtn.addEventListener('click', () => {
                document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
                newBtn.classList.add('active');

                const range = newBtn.dataset.range;
                this.statsRange = range === 'all' ? 'all' : parseInt(range);
                const filtered = this.getFilteredHistory();
                this.renderStatsOverview(filtered);
                this.renderStatsChart(filtered);
                this.renderMealBreakdown(filtered);
                this.renderStatsRecords(filtered);
            });
        });
    },

    renderHistory() {
        const list = document.getElementById('history-list');
        const goal = this.state.settings.dailyGoal;

        if (this.state.history.length === 0) {
            list.innerHTML = '<div class="history-item"><span class="history-date">No history yet.</span></div>';
            return;
        }

        // Group entries by month (YYYY-MM)
        const monthGroups = new Map();
        this.state.history.forEach(entry => {
            const monthKey = entry.date.substring(0, 7); // "YYYY-MM"
            if (!monthGroups.has(monthKey)) {
                monthGroups.set(monthKey, []);
            }
            monthGroups.get(monthKey).push(entry);
        });

        // Current month key for deciding which is expanded
        const currentMonthKey = this.getTodayDate().substring(0, 7);

        list.innerHTML = '';

        monthGroups.forEach((entries, monthKey) => {
            const isCurrentMonth = (monthKey === currentMonthKey);

            // Calculate month summary
            const daysWithData = entries.filter(e => e.calories > 0);
            const totalCals = daysWithData.reduce((sum, e) => sum + e.calories, 0);
            const avgCals = daysWithData.length > 0 ? Math.round(totalCals / daysWithData.length) : 0;

            // Month header label
            const [year, month] = monthKey.split('-');
            const monthDate = new Date(parseInt(year), parseInt(month) - 1, 1);
            const monthLabel = monthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

            // Create month group container
            const group = document.createElement('div');
            group.className = `history-month-group${isCurrentMonth ? ' expanded' : ''}`;

            // Month header (clickable to expand/collapse)
            const header = document.createElement('button');
            header.className = 'history-month-header';
            header.innerHTML = `
                <div class="history-month-left">
                    <i data-lucide="chevron-right" class="history-month-chevron"></i>
                    <span class="history-month-label">${monthLabel}</span>
                </div>
                <div class="history-month-summary">
                    <span class="history-month-days">${daysWithData.length} day${daysWithData.length !== 1 ? 's' : ''}</span>
                    <span class="history-month-avg">avg ${avgCals.toLocaleString()}</span>
                </div>
            `;

            // Day entries container
            const body = document.createElement('div');
            body.className = 'history-month-body';

            entries.forEach(entry => {
                const d = new Date(entry.date + 'T12:00:00');
                const str = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

                const isOver = entry.calories > goal;
                const badgeClass = isOver ? 'over' : 'under';
                const badgeText = isOver ? `+${(entry.calories - goal).toLocaleString()}` : 'On track';

                // Build meal dots
                let mealDotsHtml = '';
                if (entry.meals) {
                    const mealColors = {
                        breakfast: 'var(--breakfast)',
                        lunch: 'var(--lunch)',
                        dinner: 'var(--dinner)',
                        snacks: 'var(--snacks)'
                    };
                    mealDotsHtml = '<div class="history-meal-dots">';
                    MEALS.forEach(meal => {
                        if (entry.meals[meal] > 0) {
                            mealDotsHtml += `<span class="history-meal-dot" style="background:${mealColors[meal]};"></span>`;
                        }
                    });
                    mealDotsHtml += '</div>';
                }

                const item = document.createElement('div');
                item.className = 'history-item clickable';
                item.innerHTML = `
                    <div class="history-item-content">
                        <span class="history-date">${str}</span>
                        <div class="history-item-meta">
                            ${mealDotsHtml}
                            ${entry.calories > 0 ? `<span class="history-goal-badge ${badgeClass}">${badgeText}</span>` : ''}
                        </div>
                    </div>
                    <span class="history-cals">${entry.calories.toLocaleString()} cal</span>
                `;
                item.addEventListener('click', () => {
                    this.viewingDate = entry.date;
                    if (this.fp) this.fp.setDate(this.viewingDate, false);
                    this.loadDay(this.viewingDate);
                    this.renderUI();
                    document.getElementById('history-modal').classList.remove('active');
                    if (this.user) this.startCloudSync();
                });
                body.appendChild(item);
            });

            // Toggle expand/collapse on header click
            header.addEventListener('click', () => {
                group.classList.toggle('expanded');
                if (typeof lucide !== 'undefined') lucide.createIcons();
            });

            group.appendChild(header);
            group.appendChild(body);
            list.appendChild(group);
        });

        if (typeof lucide !== 'undefined') lucide.createIcons();
    },

    // ── Render ─────────────────────────────────────────
    renderUI() {
        this.updateDateDisplay();
        this.renderStats();
        this.renderProgressBar();
        this.renderGrid();
        this.renderHistory();
        this.syncMealButtons();
    },

    applyTheme() {
        const theme = this.state.settings.theme || 'default';
        document.body.classList.remove('theme-pixel');

        if (theme === 'pixel') {
            document.body.classList.add('theme-pixel');
        }

        // Update Chart.js defaults for the theme if needed
        if (this.statsChart) {
            this.renderStatsChart(this.getFilteredHistory());
        }
    },

    updateDateDisplay() {
        const label = document.getElementById('current-date-label');
        if (!label) return;

        if (this.viewingDate === this.currentDate) {
            label.textContent = 'Today';
        } else {
            const d = new Date(this.viewingDate + 'T12:00:00');
            label.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        }
    },

    changeDate(offset) {
        const d = new Date(this.viewingDate + 'T12:00:00');
        d.setDate(d.getDate() + offset);
        const newDate = d.toISOString().split('T')[0];

        // Don't go into the future
        if (newDate > this.currentDate) return;

        this.viewingDate = newDate;
        if (this.fp) {
            this.fp.setDate(this.viewingDate, false);
        }
        this.loadDay(this.viewingDate);
        this.renderUI();

        if (this.user) {
            this.startCloudSync();
        }
    },

    renderStats() {
        const count = Object.keys(this.state.currentDay.filledBoxes).length;
        const consumed = count * this.state.settings.increment;
        const goal = this.state.settings.dailyGoal;

        const consumedEl = document.getElementById('consumed-val');
        const remainingEl = document.getElementById('remaining-val');
        const goalEl = document.getElementById('goal-val');
        const remLabel = remainingEl.previousElementSibling;

        consumedEl.textContent = consumed.toLocaleString();
        goalEl.textContent = goal.toLocaleString();

        if (consumed > goal) {
            remainingEl.textContent = (consumed - goal).toLocaleString();
            if (remLabel) remLabel.textContent = 'Over';
            remainingEl.classList.add('over-limit');
        } else {
            remainingEl.textContent = (goal - consumed).toLocaleString();
            if (remLabel) remLabel.textContent = 'Remaining';
            remainingEl.classList.remove('over-limit');
        }
    },

    renderProgressBar() {
        const bar = document.getElementById('progress-bar');
        const goal = this.state.settings.dailyGoal;
        const inc = this.state.settings.increment;

        const counts = { breakfast: 0, lunch: 0, dinner: 0, snacks: 0 };
        Object.values(this.state.currentDay.filledBoxes).forEach(meal => {
            if (counts[meal] !== undefined) counts[meal]++;
        });

        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        if (total === 0) { bar.innerHTML = ''; return; }

        bar.innerHTML = MEALS.map(meal => {
            const pct = Math.min(100, (counts[meal] * inc / goal) * 100);
            if (pct === 0) return '';
            return `<div class="progress-segment" style="width:${pct}%;background:var(--${meal});box-shadow:0 0 10px var(--${meal})66;"></div>`;
        }).join('');
    },

    renderGrid() {
        const grid = document.getElementById('box-grid');
        const filled = this.state.currentDay.filledBoxes;

        const goalBoxes = Math.ceil(this.state.settings.dailyGoal / this.state.settings.increment);
        const indices = Object.keys(filled).map(Number);
        const maxIdx = indices.length > 0 ? Math.max(...indices) : -1;
        const filledCount = indices.length;

        let count = goalBoxes;

        if (filledCount >= goalBoxes || maxIdx >= goalBoxes) {
            const highestIdx = Math.max(maxIdx, goalBoxes - 1);
            const currentMaxRow = Math.ceil((highestIdx + 1) / 8) * 8;
            count = currentMaxRow + 8;
        }

        grid.innerHTML = '';

        for (let i = 0; i < count; i++) {
            const box = document.createElement('div');
            box.className = 'box';

            const meal = filled[i];
            if (meal) {
                box.classList.add('filled', `meal-${meal}`);
                if (i >= goalBoxes) {
                    box.classList.add('beyond-goal');
                    box.innerHTML = `<span class="box-label">+${this.state.settings.increment}</span>`;
                }
            } else if (i >= goalBoxes) {
                box.classList.add('beyond-goal');
            }

            box.addEventListener('click', () => this.toggleBox(i));
            grid.appendChild(box);
        }
    },

    // renderHistory is defined above in the stats panel section (line ~949)
    // with rich formatting (meal dots, goal badges, click-to-navigate).

    syncMealButtons() {
        const active = this.state.currentDay.activeMeal;
        const inc = this.state.settings.increment;

        const counts = { breakfast: 0, lunch: 0, dinner: 0, snacks: 0 };
        Object.values(this.state.currentDay.filledBoxes).forEach(meal => {
            if (counts[meal] !== undefined) counts[meal]++;
        });

        document.querySelectorAll('.meal-btn').forEach(btn => {
            const meal = btn.dataset.meal;
            btn.classList.toggle('active', meal === active);

            const calsEl = btn.querySelector('.meal-cals');
            if (calsEl) {
                const total = counts[meal] * inc;
                calsEl.textContent = total > 0 ? total.toLocaleString() + ' cal' : '—';
            }
        });
    },

    showConfirm(title, message, onConfirm) {
        const modal = document.getElementById('confirm-modal');
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;

        const okBtn = document.getElementById('confirm-ok');
        const cancelBtn = document.getElementById('confirm-cancel');
        const closeBtn = document.getElementById('close-confirm');

        const cleanup = () => {
            modal.classList.remove('active');
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            closeBtn.removeEventListener('click', handleCancel);
            // Reset long-press flag in case this was triggered by a long-press
            this.isLongPress = false;
        };

        const handleOk = () => {
            cleanup();
            onConfirm();
        };

        const handleCancel = () => {
            cleanup();
        };

        // Use addEventListener (not .onclick) so removeEventListener works correctly
        // and old handlers don't stack up across multiple showConfirm calls
        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
        closeBtn.addEventListener('click', handleCancel);

        modal.classList.add('active');
    },

    // ── Interactions ───────────────────────────────────
    toggleBox(index) {
        if (this.isLongPress) return;

        const filled = this.state.currentDay.filledBoxes;

        if (filled[index]) {
            delete filled[index];
        } else {
            filled[index] = this.state.currentDay.activeMeal;
        }

        this.saveState();
        this.renderUI();

        const boxes = document.querySelectorAll('.box');
        if (boxes[index]) {
            boxes[index].classList.remove('pop');
            void boxes[index].offsetWidth;
            boxes[index].classList.add('pop');
        }

        if (navigator.vibrate) navigator.vibrate(12);
    },

    resetDay() {
        this.state.currentDay.filledBoxes = {};
        this.saveState();
        this.renderUI();
    },

    // ── Event Listeners ────────────────────────────────
    setupEventListeners() {
        // Date navigation
        document.getElementById('prev-day').addEventListener('click', () => this.changeDate(-1));
        document.getElementById('next-day').addEventListener('click', () => this.changeDate(1));

        // Date Picker (Flatpickr)
        this.fp = flatpickr("#date-input", {
            maxDate: "today",
            disableMobile: "true",
            appendTo: document.body, // Escape overflow:hidden containers so calendar isn't clipped
            position: "auto",
            static: false,
            monthSelectorType: "static",
            animate: true,
            onChange: (selectedDates, dateStr) => {
                if (dateStr && dateStr !== this.viewingDate) {
                    this.viewingDate = dateStr;
                    this.loadDay(this.viewingDate);
                    this.renderUI();
                    if (this.user) this.startCloudSync();
                }
            },
            onDayCreate: (dObj, dStr, fp, dayElem) => {
                const date = fp.formatDate(dayElem.dateObj, "Y-m-d");
                if (this.historyDates && this.historyDates.has(date)) {
                    dayElem.classList.add('has-stats');
                }
            }
        });

        document.getElementById('date-picker-trigger').addEventListener('click', () => {
            this.fp.open();
        });

        // Auto-detect day change
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                const today = this.getTodayDate();
                if (today !== this.currentDate) {
                    const wasOnToday = (this.viewingDate === this.currentDate);
                    this.currentDate = today;
                    if (wasOnToday) {
                        this.viewingDate = today;
                        this.loadDay(this.viewingDate);
                        this.renderUI();
                    }
                }

                // Fix #3: Throttle to at most once every 5 seconds to prevent
                // listener churn when the user alt-tabs or switches apps rapidly.
                const MIN_RESYNC_MS = 5_000;
                if (this.user && (!this._lastSyncAt || Date.now() - this._lastSyncAt > MIN_RESYNC_MS)) {
                    this._lastSyncAt = Date.now();
                    this.startCloudSync();
                }
            }
        });

        // Sync button
        document.getElementById('sync-btn').addEventListener('click', () => this.handleSync());

        // Auth Modal listeners
        const authModal = document.getElementById('auth-modal');
        document.getElementById('close-auth').addEventListener('click', () => authModal.classList.remove('active'));
        authModal.addEventListener('click', e => { if (e.target === authModal) authModal.classList.remove('active'); });

        document.getElementById('login-google').addEventListener('click', () => {
            this.isLoggingIn = true;
            signInWithPopup(auth, providers.google).catch(e => {
                if (e.code === 'auth/unauthorized-domain') {
                    this.showAuthError("Unauthorized Domain: Please add your URL to Firebase Console.");
                } else {
                    this.showAuthError(e.message);
                }
            });
        });
        document.getElementById('auth-submit-btn').addEventListener('click', () => this.handleEmailLogin());
        document.getElementById('auth-toggle-btn').addEventListener('click', () => this.toggleAuthMode());
        document.getElementById('forgot-password-btn').addEventListener('click', () => {
            this.authMode = 'forgot';
            this.updateAuthUI();
        });

        // Meal selector
        document.querySelectorAll('.meal-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.state.currentDay.activeMeal = btn.dataset.meal;
                this.saveState();
                this.syncMealButtons();
            });
        });

        const grid = document.getElementById('box-grid');
        let pressTimer = null;

        const startPress = (e) => {
            if (!e.target.classList.contains('box')) return;

            // Prevent multiple timers if both touch and mouse events fire
            if (pressTimer) clearTimeout(pressTimer);

            this.isLongPress = false;
            pressTimer = setTimeout(() => {
                this.isLongPress = true;
                this.showConfirm(
                    'Reset Day',
                    'Reset all boxes for today?',
                    () => this.resetDay()
                );
                pressTimer = null;
            }, 800);
        };

        const endPress = () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        };

        grid.addEventListener('mousedown', startPress);
        grid.addEventListener('touchstart', startPress, { passive: true });
        grid.addEventListener('mouseup', endPress);
        grid.addEventListener('touchend', endPress);
        grid.addEventListener('touchcancel', endPress);
        grid.addEventListener('touchmove', endPress); // Clear timer if user scrolls
        grid.addEventListener('mouseleave', endPress);

        // Prevent context menu on boxes to allow for clean long-press
        grid.addEventListener('contextmenu', e => {
            if (e.target.classList.contains('box')) e.preventDefault();
        });

        const modal = document.getElementById('settings-modal');
        const goalInput = document.getElementById('daily-goal');

        document.getElementById('settings-btn').addEventListener('click', () => {
            goalInput.value = this.state.settings.dailyGoal;
            document.getElementById('cal-increment').value = this.state.settings.increment;
            document.getElementById('app-theme').value = this.state.settings.theme || 'default';
            modal.classList.add('active');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        });

        document.getElementById('close-settings').addEventListener('click', () => modal.classList.remove('active'));
        modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('active'); });

        document.getElementById('goal-plus').addEventListener('click', () => {
            goalInput.value = Math.min(10000, parseInt(goalInput.value) + 50);
        });
        document.getElementById('goal-minus').addEventListener('click', () => {
            goalInput.value = Math.max(500, parseInt(goalInput.value) - 50);
        });

        document.getElementById('save-settings').addEventListener('click', () => {
            const newGoal = parseInt(goalInput.value);
            const newInc = parseInt(document.getElementById('cal-increment').value);
            const newTheme = document.getElementById('app-theme').value;

            if (newGoal > 0 && newInc > 0) {
                const oldInc = this.state.settings.increment;

                if (newInc !== oldInc) {
                    const totals = { breakfast: 0, lunch: 0, dinner: 0, snacks: 0 };
                    Object.values(this.state.currentDay.filledBoxes).forEach(meal => {
                        if (totals[meal] !== undefined) totals[meal] += oldInc;
                    });

                    this.state.currentDay.filledBoxes = {};
                    let nextIdx = 0;
                    MEALS.forEach(meal => {
                        const boxCount = Math.round(totals[meal] / newInc);
                        for (let i = 0; i < boxCount; i++) {
                            this.state.currentDay.filledBoxes[nextIdx] = meal;
                            nextIdx++;
                        }
                    });
                }

                this.state.settings.dailyGoal = newGoal;
                this.state.settings.increment = newInc;
                this.state.settings.theme = newTheme;
                this.saveState();
                this.applyTheme();
                this.renderUI();
                modal.classList.remove('active');
            }
        });

        document.getElementById('reset-day-btn').addEventListener('click', () => {
            this.showConfirm(
                'Reset Day',
                'Reset all boxes for today?',
                () => {
                    this.resetDay();
                    modal.classList.remove('active');
                }
            );
        });

        const historyModal = document.getElementById('history-modal');
        document.getElementById('history-btn').addEventListener('click', () => {
            // Fix #2: No longer force-fetching. Uses 60s TTL cache — state.history
            // is kept current by updateHistoryEntry() on every box click.
            this.fetchHistory();
            historyModal.classList.add('active');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        });
        // History Modal close
        document.getElementById('close-history').addEventListener('click', () => historyModal.classList.remove('active'));
        historyModal.addEventListener('click', e => { if (e.target === historyModal) historyModal.classList.remove('active'); });

        // Debug Modal
        document.getElementById('debug-btn').addEventListener('click', () => this.handleDebugData());
        document.getElementById('close-debug').addEventListener('click', () => document.getElementById('debug-modal').classList.remove('active'));
        document.getElementById('debug-modal').addEventListener('click', e => {
            if (e.target === document.getElementById('debug-modal')) document.getElementById('debug-modal').classList.remove('active');
        });
        document.getElementById('copy-debug').addEventListener('click', () => {
            this.copyToClipboard(document.getElementById('debug-output').textContent);
        });

        // Backup & Restore
        document.getElementById('backup-btn').addEventListener('click', () => this.backupData());
        document.getElementById('restore-btn').addEventListener('click', () => this.restoreData());
        document.getElementById('restore-input').addEventListener('change', (e) => this.handleRestoreFile(e));

        // Delete All Data button
        document.getElementById('delete-all-btn').addEventListener('click', () => this.deleteAllData());

        // Close confirm modal on outside click
        const confirmModal = document.getElementById('confirm-modal');
        confirmModal.addEventListener('click', e => { if (e.target === confirmModal) confirmModal.classList.remove('active'); });
    }
};

document.addEventListener('DOMContentLoaded', () => NomBlox.init());
