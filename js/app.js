/**
 * Box-Cal — App Logic
 * Meal-based calorie tracking with color-coded boxes.
 */

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

    isLongPress: false,

    // ── Init ───────────────────────────────────────────
    init() {
        this.loadState();
        this.checkDailyReset();
        this.renderUI();
        this.setupEventListeners();
    },

    // ── Persistence ────────────────────────────────────
    loadState() {
        const DEFAULT = {
            version: STATE_VERSION,
            settings: { dailyGoal: 2000, increment: 50 },
            currentDay: { date: this.getTodayDate(), filledBoxes: {}, activeMeal: 'breakfast' },
            history: []
        };

        try {
            const raw = localStorage.getItem('box-cal-state');
            if (!raw) { this.state = DEFAULT; this.saveState(); return; }

            const parsed = JSON.parse(raw);

            // Clear stale state from old schema versions — version check handles all old formats
            if (!parsed.version || parsed.version < STATE_VERSION) {
                console.info('Box-Cal: old state detected, resetting to fresh state.');
                DEFAULT.history = Array.isArray(parsed.history) ? parsed.history : [];
                this.state = DEFAULT;
                this.saveState();
                return;
            }

            // Deep-merge with defaults so no key is ever undefined
            this.state = {
                version: STATE_VERSION,
                settings: { ...DEFAULT.settings, ...(parsed.settings || {}) },
                currentDay: { ...DEFAULT.currentDay, ...(parsed.currentDay || {}) },
                history: parsed.history || []
            };

            // Safety checks
            if (typeof this.state.currentDay.filledBoxes !== 'object' || Array.isArray(this.state.currentDay.filledBoxes)) {
                this.state.currentDay.filledBoxes = {};
            }
            if (!MEALS.includes(this.state.currentDay.activeMeal)) {
                this.state.currentDay.activeMeal = 'breakfast';
            }

        } catch (e) {
            console.error('Box-Cal: could not load state, resetting.', e);
            this.state = DEFAULT;
            this.saveState();
        }
    },

    saveState() {
        localStorage.setItem('box-cal-state', JSON.stringify(this.state));
    },

    getTodayDate() {
        return new Date().toISOString().split('T')[0];
    },

    // ── Daily Reset ────────────────────────────────────
    checkDailyReset() {
        const today = this.getTodayDate();
        if (this.state.currentDay.date === today) return;

        const filled = this.state.currentDay.filledBoxes || {};
        const count = Object.keys(filled).length;

        if (count > 0) {
            this.state.history.unshift({
                date: this.state.currentDay.date,
                calories: count * this.state.settings.increment
            });
            this.state.history = this.state.history.slice(0, 14);
        }

        this.state.currentDay = { date: today, filledBoxes: {}, activeMeal: 'breakfast' };
        this.saveState();
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
        const remaining = Math.max(0, goal - consumed);

        document.getElementById('consumed-val').textContent  = consumed.toLocaleString();
        document.getElementById('remaining-val').textContent = remaining.toLocaleString();
        document.getElementById('goal-val').textContent      = goal.toLocaleString();
    },

    renderProgressBar() {
        const bar  = document.getElementById('progress-bar');
        const goal = this.state.settings.dailyGoal;
        const inc  = this.state.settings.increment;

        // Count boxes per meal
        const counts = { breakfast: 0, lunch: 0, dinner: 0, snacks: 0 };
        Object.values(this.state.currentDay.filledBoxes).forEach(meal => {
            if (counts[meal] !== undefined) counts[meal]++;
        });

        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        if (total === 0) { bar.innerHTML = ''; return; }

        // Build stacked segments
        bar.innerHTML = MEALS.map(meal => {
            const pct = Math.min(100, (counts[meal] * inc / goal) * 100);
            if (pct === 0) return '';
            return `<div class="progress-segment" style="width:${pct}%;background:var(--${meal});box-shadow:0 0 10px var(--${meal})66;"></div>`;
        }).join('');
    },

    renderGrid() {
        const grid = document.getElementById('box-grid');
        const filled = this.state.currentDay.filledBoxes;

        const totalBoxes = Math.ceil(this.state.settings.dailyGoal / this.state.settings.increment);
        const indices = Object.keys(filled).map(Number);
        const maxIdx  = indices.length > 0 ? Math.max(...indices) : -1;
        const count   = Math.max(totalBoxes, maxIdx + 1);

        grid.innerHTML = '';

        for (let i = 0; i < count; i++) {
            const box = document.createElement('div');
            box.className = 'box';

            const meal = filled[i];
            if (meal) {
                box.classList.add('filled', `meal-${meal}`);
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
        document.querySelectorAll('.meal-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.meal === active);
        });
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

        // Pop animation
        const boxes = document.querySelectorAll('.box');
        if (boxes[index]) {
            boxes[index].classList.remove('pop');
            void boxes[index].offsetWidth; // force reflow
            boxes[index].classList.add('pop');
        }

        // Haptic
        if (navigator.vibrate) navigator.vibrate(12);
    },

    resetDay() {
        this.state.currentDay.filledBoxes = {};
        this.saveState();
        this.renderUI();
    },

    // ── Event Listeners ────────────────────────────────
    setupEventListeners() {
        // Meal selector
        document.querySelectorAll('.meal-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.state.currentDay.activeMeal = btn.dataset.meal;
                this.saveState();
                this.syncMealButtons();
            });
        });

        // Long press on grid → reset
        const grid = document.getElementById('box-grid');
        let pressTimer;

        const startPress = (e) => {
            if (!e.target.classList.contains('box')) return;
            this.isLongPress = false;
            pressTimer = setTimeout(() => {
                this.isLongPress = true;
                if (confirm('Reset all boxes for today?')) this.resetDay();
            }, 800);
        };
        const endPress = () => clearTimeout(pressTimer);

        grid.addEventListener('mousedown',  startPress);
        grid.addEventListener('touchstart', startPress, { passive: true });
        grid.addEventListener('mouseup',    endPress);
        grid.addEventListener('touchend',   endPress);
        grid.addEventListener('mouseleave', endPress);

        // Settings modal
        const modal      = document.getElementById('settings-modal');
        const goalInput  = document.getElementById('daily-goal');

        document.getElementById('settings-btn').addEventListener('click', () => {
            goalInput.value = this.state.settings.dailyGoal;
            document.getElementById('cal-increment').value = this.state.settings.increment;
            modal.classList.add('active');
            lucide.createIcons();
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
                this.state.settings.dailyGoal = newGoal;
                this.state.settings.increment = newInc;
                this.saveState();
                this.renderUI();
                modal.classList.remove('active');
            }
        });

        document.getElementById('reset-day-btn').addEventListener('click', () => {
            if (confirm('Reset all boxes for today?')) {
                this.resetDay();
                modal.classList.remove('active');
            }
        });

        // History toggle
        const historySection = document.getElementById('history-section');
        document.getElementById('history-toggle').addEventListener('click', () => {
            const collapsed = historySection.classList.toggle('collapsed');
            const icon = historySection.querySelector('[data-lucide]');
            icon.setAttribute('data-lucide', collapsed ? 'chevron-up' : 'chevron-down');
            lucide.createIcons();
        });
    }
};

document.addEventListener('DOMContentLoaded', () => BoxCal.init());
