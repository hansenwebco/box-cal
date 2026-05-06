/**
 * Box-Cal — App Logic
 * Meal-based calorie tracking with color-coded boxes.
 */

import { 
    db, auth, providers, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword,
    onAuthStateChanged, signOut, doc, getDoc, setDoc, onSnapshot,
    collection, query, orderBy, limit, getDocs 
} from './firebase.js';

const STATE_VERSION = 3; // bump when schema changes
const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];

const BoxCal = {

    // ── State ──────────────────────────────────────────
    state: {
        settings: {
            dailyGoal: 2000,
            increment: 50
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

    // ── Init ───────────────────────────────────────────
    init() {
        this.currentDate = this.getTodayDate();
        this.viewingDate = this.currentDate;
        
        this.loadLocalState();
        this.renderUI();
        this.setupEventListeners();
        this.setupAuthListener();
    },

    setupAuthListener() {
        onAuthStateChanged(auth, (user) => {
            this.user = user;
            this.updateSyncUI();
            
            if (user) {
                this.startCloudSync();
                document.getElementById('auth-modal').classList.remove('active');
            } else {
                if (this.unsubscribeSnapshot) {
                    this.unsubscribeSnapshot();
                    this.unsubscribeSnapshot = null;
                }
            }
        });
    },

    // ── Persistence ────────────────────────────────────
    loadLocalState() {
        // 1. Load Settings
        const savedSettings = localStorage.getItem('box-cal-settings');
        if (savedSettings) {
            try {
                this.state.settings = JSON.parse(savedSettings);
            } catch (e) { console.error("Error loading settings", e); }
        }

        // 2. Load History
        const savedHistory = localStorage.getItem('box-cal-history');
        if (savedHistory) {
            try {
                this.state.history = JSON.parse(savedHistory);
            } catch (e) { console.error("Error loading history", e); }
        }

        // 3. Load Current Viewing Day
        this.loadDay(this.viewingDate);
    },

    loadDay(date) {
        const key = `box-cal-day-${date}`;
        const savedDay = localStorage.getItem(key);
        
        if (savedDay) {
            try {
                this.state.currentDay = JSON.parse(savedDay);
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
        localStorage.setItem('box-cal-settings', JSON.stringify(this.state.settings));
        
        // Save current viewing day
        const dayKey = `box-cal-day-${this.state.currentDay.date}`;
        localStorage.setItem(dayKey, JSON.stringify(this.state.currentDay));
        
        // Save history (cache)
        localStorage.setItem('box-cal-history', JSON.stringify(this.state.history));
        
        // Legacy support / overall metadata
        localStorage.setItem('box-cal-last-updated', this.state.lastUpdated);
    },

    async saveState() {
        this.saveLocalState();
        
        if (this.user && !this.isSyncing) {
            try {
                // Save settings to user doc
                await setDoc(doc(db, "users", this.user.uid), { 
                    settings: this.state.settings,
                    lastUpdated: this.state.lastUpdated 
                }, { merge: true });

                // Save day to sub-collection
                const dayRef = doc(db, "users", this.user.uid, "days", this.state.currentDay.date);
                await setDoc(dayRef, {
                    ...this.state.currentDay,
                    lastUpdated: this.state.lastUpdated
                });
            } catch (e) {
                console.error("Error saving to cloud:", e);
            }
        }
    },

    async startCloudSync() {
        const userRef = doc(db, "users", this.user.uid);
        const dayRef = doc(db, "users", this.user.uid, "days", this.viewingDate);
        
        try {
            // 1. Sync Settings
            const userSnap = await getDoc(userRef);
            if (userSnap.exists()) {
                const userData = userSnap.data();
                if (userData.settings) {
                    this.state.settings = { ...this.state.settings, ...userData.settings };
                }
            }

            // 2. Sync Current Day
            const daySnap = await getDoc(dayRef);
            if (daySnap.exists()) {
                const cloudDay = daySnap.data();
                const localKey = `box-cal-day-${this.viewingDate}`;
                const localDayRaw = localStorage.getItem(localKey);
                const localDay = localDayRaw ? JSON.parse(localDayRaw) : null;

                if (!localDay || cloudDay.lastUpdated > (localDay.lastUpdated || 0)) {
                    this.state.currentDay = cloudDay;
                    this.saveLocalState(true);
                    this.renderUI();
                } else if (localDay && localDay.lastUpdated > (cloudDay.lastUpdated || 0)) {
                    // Push local to cloud
                    await setDoc(dayRef, localDay);
                }
            } else {
                // Cloud doesn't have this day yet, push local if it exists
                const localKey = `box-cal-day-${this.viewingDate}`;
                const localDayRaw = localStorage.getItem(localKey);
                if (localDayRaw) {
                    await setDoc(dayRef, JSON.parse(localDayRaw));
                }
            }

            this.isLoggingIn = false;
            this.setupSyncListeners(userRef, dayRef);
        } catch (e) {
            console.error("Cloud sync failed:", e);
        }
    },

    setupSyncListeners(userRef, dayRef) {
        if (this.unsubscribeDay) this.unsubscribeDay();
        if (this.unsubscribeSettings) this.unsubscribeSettings();

        // 1. Day Listener
        this.unsubscribeDay = onSnapshot(dayRef, (doc) => {
            if (doc.exists() && !this.isSyncing) {
                const cloudData = doc.data();
                const localKey = `box-cal-day-${this.viewingDate}`;
                const localDayRaw = localStorage.getItem(localKey);
                const localDay = localDayRaw ? JSON.parse(localDayRaw) : null;

                if (!localDay || cloudData.lastUpdated > (localDay.lastUpdated || 0)) {
                    this.isSyncing = true;
                    this.state.currentDay = cloudData;
                    this.saveLocalState(true);
                    this.renderUI();
                    this.isSyncing = false;
                }
            }
        });

        // 2. Settings Listener
        this.unsubscribeSettings = onSnapshot(userRef, (doc) => {
            if (doc.exists() && !this.isSyncing) {
                const cloudData = doc.data();
                if (cloudData.settings && cloudData.lastUpdated > (this.state.lastUpdated || 0)) {
                    this.isSyncing = true;
                    this.state.settings = { ...this.state.settings, ...cloudData.settings };
                    this.state.lastUpdated = cloudData.lastUpdated;
                    this.saveLocalState(true);
                    this.renderUI();
                    this.isSyncing = false;
                }
            }
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
            this.setupRealtimeSync(doc(db, "users", this.user.uid));
        };
        
        const handleLogout = async () => {
            modal.classList.remove('active');
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
                    await signOut(auth);
                    location.reload();
                }
            );
        } else {
            this.showAuthError(''); // Clear previous errors
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

    async handleEmailLogin(isSignup) {
        this.isLoggingIn = true;
        const email = document.getElementById('auth-email').value;
        const pass  = document.getElementById('auth-password').value;

        if (!email || !pass) { this.showAuthError('Please enter email and password.'); return; }
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

    updateSyncUI() {
        const btn = document.getElementById('sync-btn');
        const settingsUserInfo = document.getElementById('settings-user-info');
        const footerUserInfo = document.getElementById('footer-user-info');
        if (!btn) return;

        const icon = btn.querySelector('[data-lucide]');
        if (!icon) return;

        if (this.user) {
            btn.classList.add('active');
            icon.setAttribute('data-lucide', 'cloud-check');
            btn.setAttribute('aria-label', `Synced as ${this.user.email}`);
            
            if (settingsUserInfo) {
                settingsUserInfo.innerHTML = `<i data-lucide="user"></i><span>${this.user.email}</span>`;
                settingsUserInfo.style.display = 'flex';
            }
            if (footerUserInfo) {
                footerUserInfo.textContent = `Logged in as ${this.user.email}`;
            }
        } else {
            btn.classList.remove('active');
            icon.setAttribute('data-lucide', 'cloud-off');
            btn.setAttribute('aria-label', 'Sync to Cloud');
            
            if (settingsUserInfo) {
                settingsUserInfo.style.display = 'none';
            }
            if (footerUserInfo) {
                footerUserInfo.textContent = '';
            }
        }
        
        if (typeof lucide !== 'undefined') lucide.createIcons();
    },

    getTodayDate() {
        return new Date().toISOString().split('T')[0];
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

    async fetchHistory() {
        if (!this.user) return;

        try {
            const daysRef = collection(db, "users", this.user.uid, "days");
            const q = query(daysRef, orderBy("date", "desc"), limit(50));
            const querySnapshot = await getDocs(q);
            
            const history = [];
            querySnapshot.forEach((doc) => {
                const data = doc.data();
                const count = Object.keys(data.filledBoxes || {}).length;
                history.push({
                    date: data.date,
                    calories: count * (this.state.settings.increment || 50)
                });
            });

            if (history.length > 0) {
                this.state.history = history;
                this.saveLocalState(true);
                this.renderHistory();
            }
        } catch (e) {
            console.error("Error fetching history:", e);
        }
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
        this.loadDay(this.viewingDate);
        this.renderUI();
        
        if (this.user) {
            this.startCloudSync();
        }
    },

    renderStats() {
        const count    = Object.keys(this.state.currentDay.filledBoxes).length;
        const consumed = count * this.state.settings.increment;
        const goal     = this.state.settings.dailyGoal;

        const consumedEl  = document.getElementById('consumed-val');
        const remainingEl = document.getElementById('remaining-val');
        const goalEl      = document.getElementById('goal-val');
        const remLabel    = remainingEl.previousElementSibling;

        consumedEl.textContent = consumed.toLocaleString();
        goalEl.textContent     = goal.toLocaleString();

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
        const bar  = document.getElementById('progress-bar');
        const goal = this.state.settings.dailyGoal;
        const inc  = this.state.settings.increment;

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

        const goalBoxes   = Math.ceil(this.state.settings.dailyGoal / this.state.settings.increment);
        const indices     = Object.keys(filled).map(Number);
        const maxIdx      = indices.length > 0 ? Math.max(...indices) : -1;
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

    renderHistory() {
        const list = document.getElementById('history-list');

        if (this.state.history.length === 0) {
            list.innerHTML = '<div class="history-item"><span class="history-date">No history yet.</span></div>';
            return;
        }

        list.innerHTML = '';
        this.state.history.forEach(entry => {
            const d = new Date(entry.date + 'T12:00:00');
            const str = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            
            const item = document.createElement('div');
            item.className = 'history-item clickable';
            item.innerHTML = `
                <span class="history-date">${str}</span>
                <span class="history-cals">${entry.calories.toLocaleString()} cal</span>
            `;
            item.addEventListener('click', () => {
                this.viewingDate = entry.date;
                this.loadDay(this.viewingDate);
                this.renderUI();
                document.getElementById('history-modal').classList.remove('active');
                if (this.user) this.startCloudSync();
            });
            list.appendChild(item);
        });
    },

    syncMealButtons() {
        const active = this.state.currentDay.activeMeal;
        const inc    = this.state.settings.increment;

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
        };
        
        const handleOk = () => {
            cleanup();
            onConfirm();
        };
        
        const handleCancel = () => {
            cleanup();
        };
        
        okBtn.onclick = handleOk;
        cancelBtn.onclick = handleCancel;
        closeBtn.onclick = handleCancel;
        
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
                
                // Always check for cloud updates on focus
                if (this.user) this.startCloudSync();
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
        document.getElementById('login-email').addEventListener('click', () => this.handleEmailLogin(false));
        document.getElementById('signup-email').addEventListener('click', () => this.handleEmailLogin(true));

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

        grid.addEventListener('mousedown',  startPress);
        grid.addEventListener('touchstart', startPress, { passive: true });
        grid.addEventListener('mouseup',    endPress);
        grid.addEventListener('touchend',   endPress);
        grid.addEventListener('touchcancel', endPress);
        grid.addEventListener('touchmove',  endPress); // Clear timer if user scrolls
        grid.addEventListener('mouseleave', endPress);
        
        // Prevent context menu on boxes to allow for clean long-press
        grid.addEventListener('contextmenu', e => {
            if (e.target.classList.contains('box')) e.preventDefault();
        });

        const modal      = document.getElementById('settings-modal');
        const goalInput  = document.getElementById('daily-goal');

        document.getElementById('settings-btn').addEventListener('click', () => {
            goalInput.value = this.state.settings.dailyGoal;
            document.getElementById('cal-increment').value = this.state.settings.increment;
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
            const newInc  = parseInt(document.getElementById('cal-increment').value);
            
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
                this.saveState();
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

        // Close confirm modal on outside click
        const confirmModal = document.getElementById('confirm-modal');
        confirmModal.addEventListener('click', e => { if (e.target === confirmModal) confirmModal.classList.remove('active'); });
    }
};

document.addEventListener('DOMContentLoaded', () => BoxCal.init());
