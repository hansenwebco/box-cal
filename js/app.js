/**
 * Box-Cal App Logic
 * Pure Vanilla JavaScript
 */

const BoxCal = {
    state: {
        settings: {
            dailyGoal: 2000,
            increment: 50
        },
        currentDay: {
            date: "", // YYYY-MM-DD
            filledIndices: [] // Array of indices that are filled
        },
        history: []
    },
    isLongPress: false,

    init() {
        this.loadState();
        this.checkDailyReset();
        this.renderUI();
        this.setupEventListeners();
    },

    // --- Data Management ---

    loadState() {
        const saved = localStorage.getItem('box-cal-state');
        if (saved) {
            const parsed = JSON.parse(saved);
            
            // Migration check: if someone had the old 'boxesFilled' format
            if (parsed.currentDay && typeof parsed.currentDay.boxesFilled === 'number') {
                const count = parsed.currentDay.boxesFilled;
                parsed.currentDay.filledIndices = Array.from({length: count}, (_, i) => i);
                delete parsed.currentDay.boxesFilled;
            }
            
            this.state = parsed;
        } else {
            // Default initialization
            this.state.currentDay.date = this.getTodayDate();
            this.saveState();
        }
    },

    saveState() {
        localStorage.setItem('box-cal-state', JSON.stringify(this.state));
    },

    getTodayDate() {
        return new Date().toISOString().split('T')[0];
    },

    checkDailyReset() {
        const today = this.getTodayDate();
        if (this.state.currentDay.date !== today) {
            // Archive current day to history if it has activity
            const filledCount = this.state.currentDay.filledIndices?.length || 0;
            if (filledCount > 0) {
                const dayEntry = {
                    date: this.state.currentDay.date,
                    calories: filledCount * this.state.settings.increment
                };
                
                // Add to start of history and keep last 14 days
                this.state.history.unshift(dayEntry);
                this.state.history = this.state.history.slice(0, 14);
            }

            // Reset current day
            this.state.currentDay = {
                date: today,
                filledIndices: []
            };
            this.saveState();
        }
    },

    // --- UI Rendering ---

    renderUI() {
        this.renderStats();
        this.renderGrid();
        this.renderHistory();
        this.updateColors();
    },

    renderStats() {
        const filledCount = this.state.currentDay.filledIndices.length;
        const consumed = filledCount * this.state.settings.increment;
        const remaining = Math.max(0, this.state.settings.dailyGoal - consumed);
        const goal = this.state.settings.dailyGoal;

        document.getElementById('consumed-val').textContent = consumed.toLocaleString();
        document.getElementById('remaining-val').textContent = remaining.toLocaleString();
        document.getElementById('goal-val').textContent = goal.toLocaleString();

        const progressPercent = Math.min(100, (consumed / goal) * 100);
        const progressBar = document.getElementById('progress-bar');
        progressBar.style.width = `${progressPercent}%`;
    },

    renderGrid() {
        const grid = document.getElementById('box-grid');
        grid.innerHTML = '';

        const totalBoxes = Math.ceil(this.state.settings.dailyGoal / this.state.settings.increment);
        
        // Find the max index filled to ensure all filled boxes are visible
        const maxFilledIndex = this.state.currentDay.filledIndices.length > 0 
            ? Math.max(...this.state.currentDay.filledIndices) 
            : 0;
            
        const boxesToDisplay = Math.max(totalBoxes, maxFilledIndex + 1);

        for (let i = 0; i < boxesToDisplay; i++) {
            const box = document.createElement('div');
            box.className = 'box';
            if (this.state.currentDay.filledIndices.includes(i)) {
                box.classList.add('filled');
            }
            
            box.addEventListener('click', () => this.toggleBox(i));
            grid.appendChild(box);
        }
    },

    renderHistory() {
        const historyList = document.getElementById('history-list');
        historyList.innerHTML = '';

        if (this.state.history.length === 0) {
            historyList.innerHTML = '<div class="history-item"><span class="history-date">No history yet.</span></div>';
            return;
        }

        this.state.history.forEach(entry => {
            const item = document.createElement('div');
            item.className = 'history-item';
            
            const dateObj = new Date(entry.date + 'T12:00:00'); // Midday to avoid TZ issues
            const dateStr = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            
            item.innerHTML = `
                <span class="history-date">${dateStr}</span>
                <span class="history-cals">${entry.calories.toLocaleString()} cal</span>
            `;
            historyList.appendChild(item);
        });
    },

    updateColors() {
        const filledCount = this.state.currentDay.filledIndices.length;
        const consumed = filledCount * this.state.settings.increment;
        const goal = this.state.settings.dailyGoal;
        const percent = (consumed / goal) * 100;

        let statusColor = 'var(--status-low)';
        if (percent >= 100) statusColor = 'var(--status-over)';
        else if (percent >= 80) statusColor = 'var(--status-high)';
        else if (percent >= 50) statusColor = 'var(--status-mid)';

        document.documentElement.style.setProperty('--accent', statusColor);
        
        const progressBar = document.getElementById('progress-bar');
        progressBar.style.backgroundColor = statusColor;
        progressBar.style.boxShadow = `0 0 15px ${statusColor}66`;
    },

    // --- Interactions ---

    toggleBox(index) {
        // If it was a long press, don't trigger the toggle
        if (this.isLongPress) return;

        const indices = this.state.currentDay.filledIndices;
        const pos = indices.indexOf(index);
        
        if (pos > -1) {
            // Already filled, remove it
            indices.splice(pos, 1);
        } else {
            // Not filled, add it
            indices.push(index);
        }

        this.saveState();
        this.renderUI();
        
        // Add pop animation to the clicked element if it exists in DOM
        const boxes = document.querySelectorAll('.box');
        if (boxes[index]) {
            boxes[index].classList.add('pop');
            setTimeout(() => boxes[index].classList.remove('pop'), 200);
        }

        // Haptic feedback
        if (window.navigator && window.navigator.vibrate) {
            window.navigator.vibrate(15);
        }
    },

    setupEventListeners() {
        // Grid Long Press (Reset Day)
        const grid = document.getElementById('box-grid');
        let pressTimer;
        let isLongPress = false;

        grid.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('box')) {
                this.isLongPress = false;
                pressTimer = window.setTimeout(() => {
                    this.isLongPress = true;
                    if (confirm('Reset all boxes for today?')) {
                        this.state.currentDay.filledIndices = [];
                        this.saveState();
                        this.renderUI();
                    }
                }, 800);
            }
        });

        grid.addEventListener('touchstart', (e) => {
            if (e.target.classList.contains('box')) {
                this.isLongPress = false;
                pressTimer = window.setTimeout(() => {
                    this.isLongPress = true;
                    if (confirm('Reset all boxes for today?')) {
                        this.state.currentDay.filledIndices = [];
                        this.saveState();
                        this.renderUI();
                    }
                }, 800);
            }
        }, { passive: true });

        grid.addEventListener('mouseup', () => clearTimeout(pressTimer));
        grid.addEventListener('touchend', () => clearTimeout(pressTimer));
        grid.addEventListener('mouseleave', () => clearTimeout(pressTimer));

        // Settings Modal
        const settingsBtn = document.getElementById('settings-btn');
        const modal = document.getElementById('settings-modal');
        const closeBtn = document.getElementById('close-settings');
        const saveBtn = document.getElementById('save-settings');
        const resetBtn = document.getElementById('reset-day-btn');
        const goalPlus = document.getElementById('goal-plus');
        const goalMinus = document.getElementById('goal-minus');
        const goalInput = document.getElementById('daily-goal');

        settingsBtn.addEventListener('click', () => {
            goalInput.value = this.state.settings.dailyGoal;
            document.getElementById('cal-increment').value = this.state.settings.increment;
            modal.classList.add('active');
        });

        goalPlus.addEventListener('click', () => {
            goalInput.value = parseInt(goalInput.value) + 50;
        });

        goalMinus.addEventListener('click', () => {
            const current = parseInt(goalInput.value);
            if (current > 500) goalInput.value = current - 50;
        });

        resetBtn.addEventListener('click', () => {
            if (confirm('Reset all boxes for today?')) {
                this.state.currentDay.filledIndices = [];
                this.saveState();
                this.renderUI();
                modal.classList.remove('active');
            }
        });

        closeBtn.addEventListener('click', () => {
            modal.classList.remove('active');
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('active');
        });

        saveBtn.addEventListener('click', () => {
            const newGoal = parseInt(document.getElementById('daily-goal').value);
            const newInc = parseInt(document.getElementById('cal-increment').value);

            if (newGoal > 0 && newInc > 0) {
                this.state.settings.dailyGoal = newGoal;
                this.state.settings.increment = newInc;
                this.saveState();
                this.renderUI();
                modal.classList.remove('active');
            }
        });

        // History Toggle
        const historyToggle = document.getElementById('history-toggle');
        const historySection = document.getElementById('history-section');
        
        historyToggle.addEventListener('click', () => {
            historySection.classList.toggle('collapsed');
            const icon = historyToggle.querySelector('i');
            if (historySection.classList.contains('collapsed')) {
                icon.setAttribute('data-lucide', 'chevron-up');
            } else {
                icon.setAttribute('data-lucide', 'chevron-down');
            }
            lucide.createIcons();
        });
    }
};

// Start the app
document.addEventListener('DOMContentLoaded', () => {
    BoxCal.init();
});
