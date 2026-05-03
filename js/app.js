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
            // filledBoxes: { [index]: mealType }
            filledBoxes: {},
            activeMeal: 'breakfast'
        },
        history: []
    },

    user: null,
    isSyncing: false,
    isLongPress: false,
    unsubscribeSnapshot: null,

    // ── Init ───────────────────────────────────────────
    init() {
        this.loadLocalState();
        this.checkDailyReset();
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
        const DEFAULT = {
            version: STATE_VERSION,
            settings: { dailyGoal: 2000, increment: 50 },
            currentDay: { date: this.getTodayDate(), filledBoxes: {}, activeMeal: 'breakfast' },
            history: []
        };

        try {
            const raw = localStorage.getItem('box-cal-state');
            if (!raw) { this.state = DEFAULT; this.saveLocalState(); return; }

            const parsed = JSON.parse(raw);

            if (!parsed.version || parsed.version < STATE_VERSION) {
                DEFAULT.history = Array.isArray(parsed.history) ? parsed.history : [];
                this.state = DEFAULT;
                this.saveLocalState();
                return;
            }

            this.state = {
                version: STATE_VERSION,
                settings: { ...DEFAULT.settings, ...(parsed.settings || {}) },
                currentDay: { ...DEFAULT.currentDay, ...(parsed.currentDay || {}) },
                history: parsed.history || []
            };

            if (this.state.settings.increment < 50) this.state.settings.increment = 50;

            if (typeof this.state.currentDay.filledBoxes !== 'object' || Array.isArray(this.state.currentDay.filledBoxes)) {
                this.state.currentDay.filledBoxes = {};
            }
            if (!MEALS.includes(this.state.currentDay.activeMeal)) {
                this.state.currentDay.activeMeal = 'breakfast';
            }

        } catch (e) {
            console.error('Box-Cal: could not load local state.', e);
            this.state = DEFAULT;
        }
    },

    saveLocalState() {
        localStorage.setItem('box-cal-state', JSON.stringify(this.state));
    },

    async saveState() {
        this.saveLocalState();
        
        if (this.user && !this.isSyncing) {
            try {
                await setDoc(doc(db, "users", this.user.uid), this.state);
            } catch (e) {
                console.error("Error saving to cloud:", e);
            }
        }
    },

    async startCloudSync() {
        const docRef = doc(db, "users", this.user.uid);
        
        try {
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                const serverData = docSnap.data();
                const localData = this.state;
                
                // Check if local data is meaningful (has boxes or history)
                const hasLocalData = Object.keys(localData.currentDay.filledBoxes).length > 0 || localData.history.length > 0;
                
                // Compare local and server (simple stringify check)
                const isDifferent = JSON.stringify(serverData) !== JSON.stringify(localData);

                if (hasLocalData && isDifferent) {
                    this.showConflictModal(serverData);
                    return; // Wait for user choice
                } else {
                    // No local data or data is same, just use server data
                    this.state = serverData;
                    this.saveLocalState();
                    this.renderUI();
                }
            } else {
                // No server data, push local data
                await this.saveState();
            }

            this.setupRealtimeSync(docRef);
        } catch (e) {
            console.error("Cloud sync failed:", e);
        }
    },

    setupRealtimeSync(docRef) {
        if (this.unsubscribeSnapshot) this.unsubscribeSnapshot();

        this.unsubscribeSnapshot = onSnapshot(docRef, (doc) => {
            if (doc.exists() && !this.isSyncing) {
                this.isSyncing = true;
                const cloudData = doc.data();
                if (JSON.stringify(cloudData) !== JSON.stringify(this.state)) {
                    this.state = cloudData;
                    this.saveLocalState();
                    this.renderUI();
                }
                this.isSyncing = false;
            }
        });
    },

    showConflictModal(serverData) {
        const modal = document.getElementById('conflict-modal');
        const useServerBtn = document.getElementById('use-server-btn');
        const useLocalBtn = document.getElementById('use-local-btn');
        const logoutBtn = document.getElementById('conflict-logout');
        
        const handleChoice = async (useServer) => {
            modal.classList.remove('active');
            if (useServer) {
                this.state = serverData;
                this.saveLocalState();
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

    // ── Daily Reset ────────────────────────────────────
    async checkDailyReset() {
        const today = this.getTodayDate();
        if (this.state.currentDay.date === today) return;

        const filled = this.state.currentDay.filledBoxes || {};
        const count = Object.keys(filled).length;

        if (count > 0) {
            const historyEntry = {
                date: this.state.currentDay.date,
                calories: count * this.state.settings.increment
            };

            // Keep in local state for immediate view
            this.state.history.unshift(historyEntry);
            this.state.history = this.state.history.slice(0, 30); // Cache last 30 locally

            // Save to dedicated sub-collection if logged in
            if (this.user) {
                try {
                    const histRef = doc(db, "users", this.user.uid, "history", historyEntry.date);
                    await setDoc(histRef, historyEntry);
                } catch (e) {
                    console.error("Error saving day history:", e);
                }
            }
        }

        this.state.currentDay = { date: today, filledBoxes: {}, activeMeal: 'breakfast' };
        this.saveState();
    },

    async fetchHistory() {
        if (!this.user) return;

        try {
            const histRef = collection(db, "users", this.user.uid, "history");
            const q = query(histRef, orderBy("date", "desc"), limit(50)); // Fetch last 50
            const querySnapshot = await getDocs(q);
            
            const history = [];
            querySnapshot.forEach((doc) => {
                history.push(doc.data());
            });

            if (history.length > 0) {
                this.state.history = history;
                this.saveLocalState();
                this.renderHistory();
            }
        } catch (e) {
            console.error("Error fetching history:", e);
        }
    },

    // ── Render ─────────────────────────────────────────
    renderUI() {
        this.renderStats();
        this.renderProgressBar();
        this.renderGrid();
        this.renderHistory();
        this.syncMealButtons();
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

        list.innerHTML = this.state.history.map(entry => {
            const d   = new Date(entry.date + 'T12:00:00');
            const str = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            return `<div class="history-item">
                <span class="history-date">${str}</span>
                <span class="history-cals">${entry.calories.toLocaleString()} cal</span>
            </div>`;
        }).join('');
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
        // Sync button
        document.getElementById('sync-btn').addEventListener('click', () => this.handleSync());

        // Auth Modal listeners
        const authModal = document.getElementById('auth-modal');
        document.getElementById('close-auth').addEventListener('click', () => authModal.classList.remove('active'));
        authModal.addEventListener('click', e => { if (e.target === authModal) authModal.classList.remove('active'); });

        document.getElementById('login-google').addEventListener('click', () => {
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
        let pressTimer;

        const startPress = (e) => {
            if (!e.target.classList.contains('box')) return;
            this.isLongPress = false;
            pressTimer = setTimeout(() => {
                this.isLongPress = true;
                this.showConfirm(
                    'Reset Day',
                    'Reset all boxes for today?',
                    () => this.resetDay()
                );
            }, 800);
        };
        const endPress = () => clearTimeout(pressTimer);

        grid.addEventListener('mousedown',  startPress);
        grid.addEventListener('touchstart', startPress, { passive: true });
        grid.addEventListener('mouseup',    endPress);
        grid.addEventListener('touchend',   endPress);
        grid.addEventListener('mouseleave', endPress);

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
        document.getElementById('close-history').addEventListener('click', () => historyModal.classList.remove('active'));
        historyModal.addEventListener('click', e => { if (e.target === historyModal) historyModal.classList.remove('active'); });

        // Close confirm modal on outside click
        const confirmModal = document.getElementById('confirm-modal');
        confirmModal.addEventListener('click', e => { if (e.target === confirmModal) confirmModal.classList.remove('active'); });
    }
};

document.addEventListener('DOMContentLoaded', () => BoxCal.init());
