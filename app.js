// ============================================
// Taskflow Dashboard - Application Logic
// v2.0 - Split from monolith
// ============================================

        // Configuration
        const GITHUB_REPO = 'theinneslife/todo-dashboard';
        const GITHUB_BRANCH = 'main';
        const DATA_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/tasks.json`;
        const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/contents/tasks.json`;
        const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

        let githubToken = null;
        let tasks = [];
        let filteredTasks = [];
        let currentEditingTaskId = null;
        let currentDetailTaskId = null;
        let searchQuery = '';
        let selectedLabels = [];
        let currentSort = 'date';
        let allLabels = [];
        let selectedPriority = '';
        let selectedOwner = '';
        let mobileActiveColumn = 'todo';
        let batchSelectedIds = [];
        let batchMode = false;
        let timelineVisible = false;
        let activityFilter = 'all';

        // Get GitHub token from URL
        function getGithubToken() {
            const params = new URLSearchParams(window.location.search);
            return params.get('token');
        }

        // Utility functions
        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function generateUUID() {
            return crypto.randomUUID();
        }

        function formatDate(dateString) {
            if (!dateString) return '';
            const date = new Date(dateString);
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }

        function formatDateTime(isoString) {
            if (!isoString) return '';
            const date = new Date(isoString);
            return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        }

        function getRelativeTime(isoString) {
            if (!isoString) return '';
            const date = new Date(isoString);
            const now = new Date();
            const diffMs = now - date;
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMs / 3600000);
            const diffDays = Math.floor(diffMs / 86400000);

            if (diffMins < 1) return 'just now';
            if (diffMins < 60) return `${diffMins}m ago`;
            if (diffHours < 24) return `${diffHours}h ago`;
            if (diffDays < 7) return `${diffDays}d ago`;
            return formatDate(isoString);
        }

        function isOverdue(dueDate) {
            if (!dueDate) return false;
            const due = new Date(dueDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            due.setHours(0, 0, 0, 0);
            return due < today;
        }

        function isToday(dueDate) {
            if (!dueDate) return false;
            const due = new Date(dueDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            due.setHours(0, 0, 0, 0);
            return due.getTime() === today.getTime();
        }

        function isDueSoon(dueDate) {
            if (!dueDate) return false;
            if (isOverdue(dueDate) || isToday(dueDate)) return false;
            const due = new Date(dueDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            due.setHours(0, 0, 0, 0);
            const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
            return diffDays <= 3;
        }

        function isFuture(dueDate) {
            if (!dueDate) return false;
            const due = new Date(dueDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            due.setHours(0, 0, 0, 0);
            return due > today;
        }

        // GitHub API functions
        async function fetchTasksFromGithub() {
            try {
                const response = await fetch(DATA_URL + `?t=${Date.now()}`);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                return Array.isArray(data) ? data : [];
            } catch (error) {
                console.error('Error fetching tasks:', error);
                return [];
            }
        }

        async function getFileSha() {
            if (!githubToken) return null;
            try {
                const response = await fetch(GITHUB_API_URL, {
                    headers: {
                        'Authorization': `token ${githubToken}`,
                        'Accept': 'application/vnd.github.v3+json'
                    }
                });
                if (response.ok) {
                    const data = await response.json();
                    return data.sha;
                }
                return null;
            } catch (error) {
                console.error('Error getting file SHA:', error);
                return null;
            }
        }

        async function saveTasksToGithub(tasksData) {
            if (!githubToken) return false;
            try {
                const sha = await getFileSha();
                if (!sha) {
                    console.error('Could not get file SHA');
                    return false;
                }

                const content = btoa(JSON.stringify(tasksData, null, 2));
                const response = await fetch(GITHUB_API_URL, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `token ${githubToken}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        message: `Update tasks - ${new Date().toISOString()}`,
                        content: content,
                        sha: sha
                    })
                });

                return response.ok;
            } catch (error) {
                console.error('Error saving tasks:', error);
                return false;
            }
        }

        // Task operations
        // Feature 5: Smart urgency based on due date proximity
        function getUrgencyLevel(task) {
            if (!task.due_date || task.status === 'completed') return null;
            const due = new Date(task.due_date);
            const now = new Date();
            now.setHours(0, 0, 0, 0);
            due.setHours(0, 0, 0, 0);
            const daysUntil = Math.floor((due - now) / 86400000);
            if (daysUntil < 0) return 'critical'; // overdue
            if (daysUntil === 0) return 'critical'; // due today
            if (daysUntil <= 2) return 'warning'; // due in 1-2 days
            if (daysUntil <= 5) return 'approaching'; // due in 3-5 days
            return null;
        }


        // Feature 3: Check if task is blocked (Claude attempted but couldn't complete)
        function isBlocked(task) {
            if (!task.activity_log) return false;
            const lastEntry = task.activity_log[task.activity_log.length - 1];
            return lastEntry && lastEntry.action === 'attempted' && task.mode === 'auto' && task.status !== 'completed';
        }

        function createTask(title, description, priority, labels, column, dueDate, recurrence, subtasks) {
            const status = column === 'completed' ? 'completed' : (column === 'parking' ? 'pending' : (column === 'todo' ? 'pending' : 'in_progress'));
            const mode = column === 'claude' ? 'auto' : (column === 'assistance' ? 'assistance' : 'manual');
            const taskLabels = [...labels];
            if (column === 'parking') {
                if (!taskLabels.includes('Parking Lot')) {
                    taskLabels.push('Parking Lot');
                }
            }

            const newTask = {
                id: generateUUID(),
                title,
                description: description || '',
                priority: parseInt(priority),
                status,
                mode,
                labels: taskLabels,
                due_date: dueDate || null,
                recurrence: recurrence || null,
                subtasks: subtasks || [],
                comments: [],
                activity_log: [{
                    timestamp: new Date().toISOString(),
                    action: 'created',
                    by: 'System',
                    details: 'Task created'
                }],
                created_at: new Date().toISOString(),
                completed_at: status === 'completed' ? new Date().toISOString() : null,
                completion_notes: null
            };

            return newTask;
        }

        function getTaskColumn(task) {
            if (task.labels && task.labels.includes('Parking Lot')) {
                return 'parking';
            }
            if (task.status === 'completed') {
                return 'completed';
            }
            if (task.status === 'in_progress') {
                if (task.mode === 'auto') {
                    return 'claude';
                } else if (task.mode === 'assistance') {
                    return 'assistance';
                } else {
                    return 'christopher';
                }
            }
            return 'todo';
        }

        function filterTasks() {
            filteredTasks = tasks.filter(task => {
                // Label filter
                if (selectedLabels.length > 0) {
                    const hasLabel = selectedLabels.some(label =>
                        task.labels && task.labels.includes(label)
                    );
                    if (!hasLabel) return false;
                }

                // Priority filter
                if (selectedPriority) {
                    if (String(task.priority) !== selectedPriority) return false;
                }

                // Owner filter
                if (selectedOwner) {
                    const taskMode = task.mode || 'manual';
                    if (taskMode !== selectedOwner) return false;
                }

                // Search filter
                if (searchQuery) {
                    const query = searchQuery.toLowerCase();
                    const matchTitle = task.title.toLowerCase().includes(query);
                    const matchDescription = task.description && task.description.toLowerCase().includes(query);
                    const matchLabels = task.labels && task.labels.some(label => label.toLowerCase().includes(query));
                    const matchSubtasks = task.subtasks && task.subtasks.some(st => st.title.toLowerCase().includes(query));

                    if (!matchTitle && !matchDescription && !matchLabels && !matchSubtasks) {
                        return false;
                    }
                }

                return true;
            });

            sortTasks();
            updateSearchCount();
            renderBoard();
        }

        function sortTasks() {
            const sortFn = {
                'date': (a, b) => new Date(b.created_at) - new Date(a.created_at),
                'priority': (a, b) => a.priority - b.priority,
                'label': (a, b) => {
                    const labelsA = a.labels ? a.labels.join(',') : '';
                    const labelsB = b.labels ? b.labels.join(',') : '';
                    return labelsA.localeCompare(labelsB);
                },
                'due-date': (a, b) => {
                    const aOverdue = a.due_date && isOverdue(a.due_date) ? 0 : 1;
                    const bOverdue = b.due_date && isOverdue(b.due_date) ? 0 : 1;
                    if (aOverdue !== bOverdue) return aOverdue - bOverdue;

                    if (!a.due_date && !b.due_date) return 0;
                    if (!a.due_date) return 1;
                    if (!b.due_date) return -1;

                    return new Date(a.due_date) - new Date(b.due_date);
                }
            };

            const fn = sortFn[currentSort] || sortFn['date'];
            filteredTasks.sort(fn);
        }

        function updateAllLabels() {
            const labelSet = new Set();
            tasks.forEach(task => {
                if (task.labels) {
                    task.labels.forEach(label => {
                        if (label !== 'Parking Lot') {
                            labelSet.add(label);
                        }
                    });
                }
            });
            allLabels = Array.from(labelSet).sort();
            renderLabelFilters();
        }

        function updateTokenStatus() {
            const status = document.getElementById('tokenStatus');
            const addBtn = document.getElementById('addTaskBtn');

            if (githubToken) {
                status.textContent = '✓ Authenticated';
                status.classList.add('active');
                addBtn.disabled = false;
            } else {
                status.textContent = 'Read-only';
                status.classList.remove('active');
                addBtn.disabled = true;
            }
        }

        async function loadTasks() {
            document.body.classList.add('loading');
            try {
                tasks = await fetchTasksFromGithub();
                updateAllLabels();
                filterTasks();
                // Feature 2: Update timeline if visible
                if (timelineVisible) renderTimeline();
            } catch (error) {
                console.error('Error loading tasks:', error);
            } finally {
                document.body.classList.remove('loading');
            }
        }

        // UI Functions
        function renderLabelFilters() {
            const container = document.getElementById('labelFilters');
            container.innerHTML = '';

            // All label
            const allBtn = document.createElement('button');
            allBtn.className = 'label-pill active';
            allBtn.textContent = 'All';
            allBtn.onclick = () => {
                selectedLabels = [];
                document.querySelectorAll('.label-pill').forEach(b => b.classList.remove('active'));
                allBtn.classList.add('active');
                filterTasks();
            };
            container.appendChild(allBtn);

            // High Priority label
            const highPriorityBtn = document.createElement('button');
            highPriorityBtn.className = 'label-pill';
            highPriorityBtn.textContent = 'High Priority';
            highPriorityBtn.onclick = () => {
                toggleLabelFilter(highPriorityBtn, 'High Priority');
            };
            container.appendChild(highPriorityBtn);

            // Parking Lot label
            const parkingBtn = document.createElement('button');
            parkingBtn.className = 'label-pill';
            parkingBtn.textContent = 'Parking Lot';
            parkingBtn.onclick = () => {
                toggleLabelFilter(parkingBtn, 'Parking Lot');
            };
            container.appendChild(parkingBtn);

            // Custom labels
            allLabels.forEach(label => {
                const btn = document.createElement('button');
                btn.className = 'label-pill';
                btn.textContent = label;
                btn.onclick = () => {
                    toggleLabelFilter(btn, label);
                };
                container.appendChild(btn);
            });
        }

        function toggleLabelFilter(btn, label) {
            const allBtn = Array.from(document.querySelectorAll('.label-pill'))[0];

            if (btn.classList.contains('active')) {
                btn.classList.remove('active');
                selectedLabels = selectedLabels.filter(l => l !== label);
            } else {
                btn.classList.add('active');
                allBtn.classList.remove('active');
                selectedLabels.push(label);
            }

            if (selectedLabels.length === 0) {
                allBtn.classList.add('active');
            }

            filterTasks();
        }

        function updateSearchCount() {
            const count = document.getElementById('searchCount');
            if (searchQuery) {
                count.textContent = `${filteredTasks.length} result${filteredTasks.length !== 1 ? 's' : ''}`;
            } else {
                count.textContent = '';
            }
        }

        function renderBoard() {
            const kanban = document.getElementById('kanban');
            kanban.innerHTML = '';

            const columns = [
                { id: 'todo', title: 'To Do', dot: '#5856d6', getColor: () => '#5856d6' },
                { id: 'christopher', title: 'Christopher', dot: '#007aff', getColor: () => '#007aff' },
                { id: 'claude', title: 'Claude', dot: '#af52de', getColor: () => '#af52de' },
                { id: 'assistance', title: 'Assistance', dot: '#ff9f0a', getColor: () => '#ff9f0a' },
                { id: 'completed', title: 'Completed', dot: '#34c759', getColor: () => '#34c759', subtitle: 'Cleared Sundays' },
                { id: 'parking', title: 'Parking Lot', dot: '#8e8e93', getColor: () => '#8e8e93' }
            ];

            columns.forEach(col => {
                const columnEl = document.createElement('div');
                columnEl.className = 'column';
                columnEl.id = `col-${col.id}`;
                columnEl.ondragover = (e) => {
                    e.preventDefault();
                    columnEl.classList.add('drag-over');
                };
                columnEl.ondragleave = () => {
                    columnEl.classList.remove('drag-over');
                };
                columnEl.ondrop = (e) => {
                    e.preventDefault();
                    columnEl.classList.remove('drag-over');
                    handleDrop(e, col.id);
                };

                const header = document.createElement('div');
                header.className = 'column-header';
                const dot = document.createElement('div');
                dot.className = 'column-dot';
                dot.style.backgroundColor = col.dot;
                const title = document.createElement('div');
                title.className = 'column-title';
                title.textContent = col.title;
                if (col.subtitle) {
                    title.innerHTML += `<div style="font-size: 11px; color: #6e6e73; font-weight: 400; margin-top: 2px;">${escapeHtml(col.subtitle)}</div>`;
                }
                const count = document.createElement('div');
                count.className = 'column-count';

                const columnTasks = filteredTasks.filter(t => getTaskColumn(t) === col.id);
                count.textContent = columnTasks.length;

                header.appendChild(dot);
                header.appendChild(title);
                header.appendChild(count);
                columnEl.appendChild(header);

                const taskList = document.createElement('div');
                taskList.className = 'task-list';

                columnTasks.forEach(task => {
                    taskList.appendChild(renderTaskCard(task));
                });

                columnEl.appendChild(taskList);
                kanban.appendChild(columnEl);
            });

            // Mobile tabs
            renderMobileTabs(columns);
        }

        function renderMobileTabs(columns) {
            const tabsEl = document.getElementById('mobileTabs');
            if (!tabsEl) return;
            tabsEl.innerHTML = '';

            columns.forEach(col => {
                const colTasks = filteredTasks.filter(t => getTaskColumn(t) === col.id);
                const tab = document.createElement('button');
                tab.className = 'mobile-tab' + (mobileActiveColumn === col.id ? ' active' : '');
                tab.innerHTML = `${col.title} <span class="tab-count">${colTasks.length}</span>`;
                tab.onclick = () => {
                    mobileActiveColumn = col.id;
                    document.querySelectorAll('.mobile-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    document.querySelectorAll('.column').forEach(c => {
                        c.classList.remove('mobile-active');
                        if (c.id === `col-${col.id}`) c.classList.add('mobile-active');
                    });
                };
                tabsEl.appendChild(tab);
            });

            // Activate the current mobile column
            const activeCol = document.getElementById(`col-${mobileActiveColumn}`);
            if (activeCol) activeCol.classList.add('mobile-active');
        }

        function renderTaskCard(task) {
            const card = document.createElement('div');
            card.className = 'task-card';
            if (task.status === 'completed') {
                card.classList.add('completed');
            }
            card.id = `task-${task.id}`;
            card.draggable = githubToken ? true : false;
            // Feature 7: Batch selection on shift-click
            card.addEventListener('click', (e) => {
                if (e.shiftKey && githubToken) {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleBatchSelect(task.id, card);
                }
            });

            const header = document.createElement('div');
            header.className = 'task-header';

            // Checkbox
            const checkbox = document.createElement('div');
            checkbox.className = 'task-checkbox';
            if (task.status === 'completed') {
                checkbox.classList.add('checked');
            }
            checkbox.onclick = (e) => {
                e.stopPropagation();
                if (!githubToken) return;
                toggleTaskComplete(task);
            };
            header.appendChild(checkbox);

            // Content
            const content = document.createElement('div');
            content.className = 'task-content';

            const title = document.createElement('div');
            title.className = 'task-title';
            title.textContent = task.title;
            title.onclick = () => showTaskDetail(task);
            content.appendChild(title);

            // Description
            if (task.description) {
                const description = document.createElement('div');
                description.className = 'task-description';
                description.textContent = task.description;
                content.appendChild(description);
            }

            // Meta info
            const meta = document.createElement('div');
            meta.className = 'task-meta';

            // Due date
            if (task.due_date) {
                const dueDate = document.createElement('div');
                dueDate.className = 'task-due-date';
                if (isOverdue(task.due_date) && task.status !== 'completed') {
                    dueDate.classList.add('overdue');
                } else if (isToday(task.due_date)) {
                    dueDate.classList.add('today');
                } else if (isDueSoon(task.due_date)) {
                    dueDate.classList.add('due-soon');
                } else {
                    dueDate.classList.add('future');
                }
                dueDate.textContent = formatDate(task.due_date);
                meta.appendChild(dueDate);
            }

            // Priority
            if (task.priority) {
                const priority = document.createElement('div');
                priority.className = `task-priority priority-${task.priority}`;
                priority.innerHTML = '<span class="priority-dot"></span>';
                const priorityText = document.createElement('span');
                const priorityNames = { '1': 'High', '2': 'Medium', '3': 'Low' };
                priorityText.textContent = priorityNames[task.priority];
                priority.appendChild(priorityText);
                meta.appendChild(priority);
            }

            // Recurrence badge
            if (task.recurrence) {
                const recurrence = document.createElement('div');
                recurrence.className = 'task-recurrence';
                recurrence.textContent = `↻ ${task.recurrence}`;
                meta.appendChild(recurrence);
            }

            // Feature 10: Delegation Notes display
            if (task.delegation_notes && task.mode === 'auto') {
                html += '<div class="detail-section"><div class="delegation-notes">';
                html += '<div class="delegation-notes-title">🤖 Delegation Notes for Claude</div>';
                html += '<div class="delegation-notes-display">' + escapeHtml(task.delegation_notes) + '</div>';
                html += '</div></div>';
            }

            // Labels
            if (task.labels && task.labels.length > 0) {
                task.labels.forEach(label => {
                    if (label !== 'Parking Lot') {
                        const labelEl = document.createElement('span');
                        labelEl.className = 'task-label';
                        labelEl.textContent = label;
                        meta.appendChild(labelEl);
                    }
                });
            }

            // Feature 3: Blocked badge
            if (isBlocked(task)) {
                const blockedBadge = document.createElement('div');
                blockedBadge.className = 'badge-blocked';
                blockedBadge.textContent = 'Blocked';
                blockedBadge.title = task.activity_log[task.activity_log.length - 1].details;
                meta.appendChild(blockedBadge);
            }

            // Feature 5: Urgency label
            if (urgency) {
                const urgencyLabel = document.createElement('span');
                urgencyLabel.className = 'urgency-label ' + urgency;
                const urgencyTexts = { critical: 'OVERDUE', warning: 'Due Soon', approaching: 'Upcoming' };
                if (isOverdue(task.due_date)) urgencyTexts.critical = 'OVERDUE';
                else if (urgency === 'critical') urgencyTexts.critical = 'Due Today';
                urgencyLabel.textContent = urgencyTexts[urgency] || '';
                meta.appendChild(urgencyLabel);
            }

            // Feature 6: Recurrence badge (already exists but ensure styling)

            // Subtasks progress
            if (task.subtasks && task.subtasks.length > 0) {
                const subtaskDiv = document.createElement('div');
                subtaskDiv.className = 'task-subtasks';
                const completed = task.subtasks.filter(s => s.done).length;
                const subtaskText = document.createElement('span');
                subtaskText.textContent = `${completed}/${task.subtasks.length} subtasks`;
                const progressBar = document.createElement('div');
                progressBar.className = 'subtask-progress';
                const progressFill = document.createElement('div');
                progressFill.className = 'subtask-progress-fill';
                progressFill.style.width = `${(completed / task.subtasks.length) * 100}%`;
                progressBar.appendChild(progressFill);
                subtaskDiv.appendChild(subtaskText);
                subtaskDiv.appendChild(progressBar);
                meta.appendChild(subtaskDiv);
            }

            content.appendChild(meta);
            header.appendChild(content);
            card.appendChild(header);

            // Footer with assignee and actions
            const footer = document.createElement('div');
            footer.className = 'task-footer';

            const assignee = document.createElement('div');
            assignee.className = 'task-assignee';
            const ownerConfig = { 'manual': { name: 'Christopher', color: '#007aff' }, 'auto': { name: 'Claude', color: '#af52de' }, 'assistance': { name: 'Assistance', color: '#ff9f0a' } };
            const owner = ownerConfig[task.mode] || ownerConfig['manual'];
            assignee.innerHTML = `<span class="assignee-dot" style="background-color: ${owner.color}"></span>${owner.name}`;
            assignee.onclick = (e) => {
                e.stopPropagation();
                if (!githubToken) return;
                toggleAssignee(task);
            };
            footer.appendChild(assignee);

            const actions = document.createElement('div');
            actions.className = 'task-actions';

            const activityBtn = document.createElement('button');
            activityBtn.className = 'task-action-btn';
            activityBtn.textContent = '📋';
            activityBtn.title = 'View activity';
            activityBtn.onclick = (e) => {
                e.stopPropagation();
                showTaskDetail(task);
            };
            actions.appendChild(activityBtn);

            footer.appendChild(actions);
            card.appendChild(footer);

            card.ondragstart = (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('taskId', task.id);
            };

            return card;
        }

        async function toggleTaskComplete(task) {
            task.status = task.status === 'completed' ? 'pending' : 'completed';
            if (task.status === 'completed') {
                task.completed_at = new Date().toISOString();
            } else {
                task.completed_at = null;
            }

            task.activity_log = task.activity_log || [];
            task.activity_log.push({
                timestamp: new Date().toISOString(),
                action: 'completed',
                by: 'Christopher',
                details: task.status === 'completed' ? 'Task completed' : 'Task reopened'
            });

            await saveTasksToGithub(tasks);
            filterTasks();
        }

        async function toggleAssignee(task) {
            // Cycle: manual -> auto -> assistance -> manual
            if (task.mode === 'manual') {
                task.mode = 'auto';
            } else if (task.mode === 'auto') {
                task.mode = 'assistance';
            } else {
                task.mode = 'manual';
            }
            if (task.status !== 'completed' && task.status !== 'pending') {
                task.status = 'in_progress';
            }

            const ownerNames = { 'manual': 'Christopher', 'auto': 'Claude', 'assistance': 'Assistance' };
            task.activity_log = task.activity_log || [];
            task.activity_log.push({
                timestamp: new Date().toISOString(),
                action: 'assigned',
                by: 'System',
                details: `Assigned to ${ownerNames[task.mode]}`
            });

            await saveTasksToGithub(tasks);
            filterTasks();
        }

        async function handleDrop(e, columnId) {
            const taskId = e.dataTransfer.getData('taskId');
            const task = tasks.find(t => t.id === taskId);
            if (!task || !githubToken) return;

            const columnMapping = {
                'todo': { status: 'pending', mode: 'manual', removeLabel: 'Parking Lot' },
                'christopher': { status: 'in_progress', mode: 'manual' },
                'claude': { status: 'in_progress', mode: 'auto' },
                'assistance': { status: 'in_progress', mode: 'assistance' },
                'completed': { status: 'completed', mode: 'manual', completedAt: new Date().toISOString() },
                'parking': { status: 'pending', mode: 'manual', addLabel: 'Parking Lot' }
            };

            const mapping = columnMapping[columnId];
            if (!mapping) return;

            const oldColumn = getTaskColumn(task);
            task.status = mapping.status;
            task.mode = mapping.mode;

            if (mapping.removeLabel) {
                task.labels = task.labels ? task.labels.filter(l => l !== mapping.removeLabel) : [];
            }

            if (mapping.addLabel) {
                task.labels = task.labels || [];
                if (!task.labels.includes(mapping.addLabel)) {
                    task.labels.push(mapping.addLabel);
                }
            }

            if (mapping.completedAt) {
                task.completed_at = mapping.completedAt;
            }

            task.activity_log = task.activity_log || [];
            task.activity_log.push({
                timestamp: new Date().toISOString(),
                action: 'moved',
                by: 'User',
                details: `Moved from ${oldColumn} to ${columnId}`
            });

            await saveTasksToGithub(tasks);
            filterTasks();
        }

        function showTaskDetail(task) {
            const modal = document.getElementById('detailModal');
            const title = document.getElementById('detailTitle');
            const content = document.getElementById('detailContent');

            title.textContent = task.title;
            currentDetailTaskId = task.id;

            let html = '';

            // Action buttons
            if (githubToken) {
                html += `<div class="detail-actions">`;
                html += `<button class="primary-action" onclick="showEditTaskModal('${task.id}')">✎ Edit Task</button>`;
                html += `</div>`;
            }

            // Description
            if (task.description) {
                html += `
                    <div class="detail-section">
                        <div class="detail-content">${escapeHtml(task.description)}</div>
                    </div>
                `;
            }

            // Metadata
            html += '<div class="detail-section"><div class="detail-title">Details</div>';
            html += `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px;">`;
            html += `<div><span style="color: #6e6e73;">Status:</span> ${task.status}</div>`;
            const detailOwnerNames = { 'manual': 'Christopher', 'auto': 'Claude', 'assistance': 'Assistance' };
            html += `<div><span style="color: #6e6e73;">Owner:</span> ${detailOwnerNames[task.mode] || 'Christopher'}</div>`;
            html += `<div><span style="color: #6e6e73;">Priority:</span> ${['', 'High', 'Medium', 'Low'][task.priority]}</div>`;
            if (task.due_date) {
                html += `<div><span style="color: #6e6e73;">Due:</span> ${formatDate(task.due_date)}</div>`;
            }
            if (task.recurrence) {
                html += `<div><span style="color: #6e6e73;">Repeat:</span> ${task.recurrence}</div>`;
            }
            html += `</div></div>`;

            // Feature 10: Delegation Notes display
            if (task.delegation_notes && task.mode === 'auto') {
                html += '<div class="detail-section"><div class="delegation-notes">';
                html += '<div class="delegation-notes-title">🤖 Delegation Notes for Claude</div>';
                html += '<div class="delegation-notes-display">' + escapeHtml(task.delegation_notes) + '</div>';
                html += '</div></div>';
            }

            // Labels
            if (task.labels && task.labels.length > 0) {
                html += '<div class="detail-section"><div class="detail-title">Labels</div>';
                html += '<div style="display: flex; flex-wrap: wrap; gap: 8px;">';
                task.labels.forEach(label => {
                    html += `<span class="task-label">${escapeHtml(label)}</span>`;
                });
                html += '</div></div>';
            }

            // Subtasks
            if (task.subtasks && task.subtasks.length > 0) {
                html += '<div class="detail-section"><div class="detail-title">Subtasks</div><div class="subtasks-list">';
                task.subtasks.forEach((subtask, idx) => {
                    html += `
                        <div class="subtask-item ${subtask.done ? 'done' : ''}">
                            <div class="subtask-checkbox ${subtask.done ? 'checked' : ''}" onclick="toggleSubtask('${task.id}', ${idx})"></div>
                            <span class="subtask-text">${escapeHtml(subtask.title)}</span>
                        </div>
                    `;
                });
                html += '</div></div>';
            }

            // Comments
            html += '<div class="detail-section"><div class="detail-title">Comments</div>';
            html += '<div class="comments-section">';
            const comments = task.comments || [];
            if (comments.length === 0) {
                html += '<div class="no-comments">No comments yet</div>';
            } else {
                comments.forEach(comment => {
                    html += `
                        <div class="comment-item">
                            <div class="comment-meta">
                                <span class="comment-author">${escapeHtml(comment.by)}</span>
                                <span class="comment-time">${getRelativeTime(comment.timestamp)}</span>
                            </div>
                            <div class="comment-text">${escapeHtml(comment.text)}</div>
                        </div>
                    `;
                });
            }
            if (githubToken) {
                html += `
                    <div class="comment-input-wrapper">
                        <textarea id="commentInput" placeholder="Add a comment..." rows="1"></textarea>
                        <button onclick="addComment('${task.id}')">Post</button>
                    </div>
                `;
            }
            html += '</div></div>';

            // Activity log
            if (task.activity_log && task.activity_log.length > 0) {
                html += '<div class="detail-section"><div class="detail-title">Activity</div><div class="activity-timeline">';
                const log = [...task.activity_log].reverse();
                log.forEach(entry => {
                    const icons = {
                        'created': '\u2713',
                        'moved': '\u2192',
                        'completed': '\u2713',
                        'assigned': '\ud83d\udc64',
                        'edited': '\u270e',
                        'commented': '\ud83d\udcac'
                    };
                    const icon = icons[entry.action] || '\u2022';
                    html += `
                        <div class="activity-item">
                            <div class="activity-icon">${icon}</div>
                            <div class="activity-content">
                                <div class="activity-action">${escapeHtml(entry.details)}</div>
                                <div class="activity-time">${getRelativeTime(entry.timestamp)}</div>
                            </div>
                        </div>
                    `;
                });
                html += '</div></div>';
            }

            content.innerHTML = html;
            modal.classList.add('active');
        }

        function toggleSubtask(taskId, subtaskIdx) {
            const task = tasks.find(t => t.id === taskId);
            if (!task || !githubToken) return;

            task.subtasks[subtaskIdx].done = !task.subtasks[subtaskIdx].done;
            task.activity_log = task.activity_log || [];
            task.activity_log.push({
                timestamp: new Date().toISOString(),
                action: 'edited',
                by: 'User',
                details: `Subtask ${task.subtasks[subtaskIdx].done ? 'completed' : 'reopened'}`
            });

            saveTasksToGithub(tasks).then(() => {
                showTaskDetail(task);
            });
        }

        function updateDelegationVisibility() {
            const column = document.getElementById('taskColumn').value;
            const group = document.getElementById('delegationNotesGroup');
            if (group) {
                group.style.display = (column === 'claude') ? 'block' : 'none';
            }
        }

        function showAddTaskModal() {
            if (!githubToken) return;
            currentEditingTaskId = null;
            document.getElementById('modalTitle').textContent = 'Add Task';
            document.getElementById('taskTitle').value = '';
            document.getElementById('taskDescription').value = '';
            document.getElementById('taskColumn').value = 'todo';
            document.getElementById('taskDelegationNotes').value = '';
            updateDelegationVisibility();
            document.getElementById('taskDueDate').value = '';
            document.getElementById('taskRecurrence').value = '';
            document.getElementById('initialSubtasks').innerHTML = '';
            document.querySelectorAll('.priority-button').forEach((btn, idx) => {
                btn.classList.toggle('active', btn.dataset.priority === '1');
            });
            clearLabelTags();
            document.getElementById('addTaskModal').classList.add('active');
        }

        function clearLabelTags() {
            const container = document.getElementById('labelTagInput');
            container.querySelectorAll('.tag').forEach(tag => tag.remove());
        }

        function addLabelTag(label) {
            const container = document.getElementById('labelTagInput');
            const input = container.querySelector('input');

            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.innerHTML = `${escapeHtml(label)}<span class="tag-remove">×</span>`;
            tag.querySelector('.tag-remove').onclick = () => tag.remove();

            container.insertBefore(tag, input);
            input.value = '';
        }

        function getLabelTagsFromUI() {
            const container = document.getElementById('labelTagInput');
            const tags = [];
            container.querySelectorAll('.tag').forEach(tag => {
                const text = tag.textContent.trim().slice(0, -1); // Remove the × button
                tags.push(text);
            });
            return tags;
        }

        async function saveTask() {
            const title = document.getElementById('taskTitle').value.trim();
            const description = document.getElementById('taskDescription').value.trim();
            const labels = getLabelTagsFromUI();
            const priority = document.querySelector('.priority-button.active').dataset.priority;
            const column = document.getElementById('taskColumn').value;
            const dueDate = document.getElementById('taskDueDate').value;
            const recurrence = document.getElementById('taskRecurrence').value;

            if (!title) {
                alert('Please enter a task title');
                return;
            }

            if (!githubToken) {
                alert('You need to be authenticated to save tasks');
                return;
            }

            if (currentEditingTaskId) {
                const task = tasks.find(t => t.id === currentEditingTaskId);
                if (task) {
                    task.title = title;
                    task.description = description;
                    task.labels = labels;
                    task.priority = parseInt(priority);
                    task.due_date = dueDate || null;
                    task.recurrence = recurrence || null;

                    // Update column/status/mode based on selected column
                    const columnMapping = {
                        'todo': { status: 'pending', mode: 'manual' },
                        'christopher': { status: 'in_progress', mode: 'manual' },
                        'claude': { status: 'in_progress', mode: 'auto' },
                        'assistance': { status: 'in_progress', mode: 'assistance' },
                        'completed': { status: 'completed', mode: task.mode },
                        'parking': { status: 'pending', mode: 'manual' }
                    };
                    const mapping = columnMapping[column];
                    if (mapping) {
                        task.status = mapping.status;
                        task.mode = mapping.mode;
                        if (column === 'parking' && !task.labels.includes('Parking Lot')) {
                            task.labels.push('Parking Lot');
                        } else if (column !== 'parking') {
                            task.labels = task.labels.filter(l => l !== 'Parking Lot');
                        }
                        if (column === 'completed' && !task.completed_at) {
                            task.completed_at = new Date().toISOString();
                        }
                    }

                    // Feature 10: Handle delegation notes
                    const delegationNotes = document.getElementById('taskDelegationNotes').value.trim();
                    if (delegationNotes) {
                        task.delegation_notes = delegationNotes;
                    }

                    // Handle subtasks from edit form
                    const subtaskInputs = document.querySelectorAll('#initialSubtasks .subtask-input');
                    if (subtaskInputs.length > 0) {
                        task.subtasks = Array.from(subtaskInputs).map((input, idx) => ({
                            title: input.value.trim(),
                            done: task.subtasks && task.subtasks[idx] ? task.subtasks[idx].done : false
                        })).filter(st => st.title);
                    }

                    task.activity_log = task.activity_log || [];
                    task.activity_log.push({
                        timestamp: new Date().toISOString(),
                        action: 'edited',
                        by: 'Christopher',
                        details: 'Task edited'
                    });
                }
            } else {
                // Collect subtasks from form
                const newSubtaskInputs = document.querySelectorAll('#initialSubtasks .subtask-input');
                const newSubtasks = Array.from(newSubtaskInputs).map(input => ({
                    title: input.value.trim(),
                    done: false
                })).filter(st => st.title);
                const newTask = createTask(title, description, priority, labels, column, dueDate, recurrence, newSubtasks);
                // Feature 10: delegation notes for new tasks
                const newDelegationNotes = document.getElementById('taskDelegationNotes').value.trim();
                if (newDelegationNotes) {
                    newTask.delegation_notes = newDelegationNotes;
                }
                tasks.push(newTask);
            }

            await saveTasksToGithub(tasks);
            document.getElementById('addTaskModal').classList.remove('active');
            await loadTasks();
        }

        function showStatsModal() {
            const modal = document.getElementById('statsModal');

            // Calculate statistics
            const thisWeekStart = new Date();
            thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
            thisWeekStart.setHours(0, 0, 0, 0);

            const lastWeekStart = new Date(thisWeekStart);
            lastWeekStart.setDate(lastWeekStart.getDate() - 7);

            let thisWeekCompleted = 0;
            let lastWeekCompleted = 0;
            let totalCreated = 0;
            let totalCompleted = 0;
            let totalTime = 0;

            const priorityCounts = { 1: 0, 2: 0, 3: 0 };
            const columnCounts = {};

            tasks.forEach(task => {
                // Priority
                priorityCounts[task.priority]++;

                // Column
                const col = getTaskColumn(task);
                columnCounts[col] = (columnCounts[col] || 0) + 1;

                // Week stats
                const completedDate = task.completed_at ? new Date(task.completed_at) : null;
                if (completedDate) {
                    if (completedDate >= thisWeekStart) {
                        thisWeekCompleted++;
                    } else if (completedDate >= lastWeekStart) {
                        lastWeekCompleted++;
                    }
                    totalCompleted++;

                    const createdDate = new Date(task.created_at);
                    const daysDiff = Math.floor((completedDate - createdDate) / (1000 * 60 * 60 * 24));
                    totalTime += daysDiff;
                }
                totalCreated++;
            });

            const avgTime = totalCompleted > 0 ? Math.round(totalTime / totalCompleted) : 0;

            // Render stats grid
            let statsHtml = `
                <div class="stat-card">
                    <div class="stat-label">Completed This Week</div>
                    <div class="stat-value">${thisWeekCompleted}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Completed Last Week</div>
                    <div class="stat-value">${lastWeekCompleted}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Avg Time to Complete</div>
                    <div class="stat-value">${avgTime}</div>
                    <div class="stat-subtext">days</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Total Completed</div>
                    <div class="stat-value">${totalCompleted}</div>
                    <div class="stat-subtext">of ${totalCreated}</div>
                </div>
            `;

            document.getElementById('statsGrid').innerHTML = statsHtml;

            // Priority chart
            let priorityHtml = '';
            const priorityLabels = { 1: 'High', 2: 'Medium', 3: 'Low' };
            const maxPriority = Math.max(...Object.values(priorityCounts));
            Object.entries(priorityCounts).forEach(([p, count]) => {
                const height = maxPriority > 0 ? (count / maxPriority) * 100 : 0;
                priorityHtml += `<div class="bar priority-${p}" style="height: ${height}%;">${count}</div>`;
            });
            document.getElementById('priorityChart').innerHTML = priorityHtml;

            // Column chart
            const columnLabels = { 'todo': 'To Do', 'christopher': 'Christopher', 'claude': 'Claude', 'assistance': 'Assistance', 'completed': 'Completed', 'parking': 'Parking' };
            let columnHtml = '';
            const maxColumn = Math.max(...Object.values(columnCounts));
            Object.entries(columnCounts).forEach(([col, count]) => {
                const height = maxColumn > 0 ? (count / maxColumn) * 100 : 0;
                columnHtml += `<div class="bar" style="height: ${height}%; background-color: #007aff;">${count}</div>`;
            });
            document.getElementById('columnChart').innerHTML = columnHtml;

            // Burndown chart
            renderBurndownChart();

            modal.classList.add('active');
        }

        function renderBurndownChart() {
            const svg = document.getElementById('burndownChart');
            svg.innerHTML = '';

            const padding = 40;
            const width = svg.clientWidth - 2 * padding;
            const height = svg.clientHeight - 2 * padding;

            // Get 14-day history
            const days = [];
            const openCounts = [];
            const createdCounts = [];

            for (let i = 13; i >= 0; i--) {
                const date = new Date();
                date.setDate(date.getDate() - i);
                date.setHours(0, 0, 0, 0);
                days.push(date);

                let openCount = 0;
                let createdCount = 0;

                tasks.forEach(task => {
                    const createdDate = new Date(task.created_at);
                    createdDate.setHours(0, 0, 0, 0);
                    const completedDate = task.completed_at ? new Date(task.completed_at) : null;
                    if (completedDate) {
                        completedDate.setHours(0, 0, 0, 0);
                    }

                    if (createdDate <= date) {
                        createdCount++;
                        if (!completedDate || completedDate > date) {
                            openCount++;
                        }
                    }
                });

                openCounts.push(openCount);
                createdCounts.push(createdCount);
            }

            const maxOpen = Math.max(...openCounts, ...createdCounts);

            // Draw axes
            const axisGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            const xAxisLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            xAxisLine.setAttribute('x1', padding);
            xAxisLine.setAttribute('y1', height + padding);
            xAxisLine.setAttribute('x2', width + padding);
            xAxisLine.setAttribute('y2', height + padding);
            xAxisLine.setAttribute('stroke', '#e5e5e7');
            xAxisLine.setAttribute('stroke-width', '1');
            axisGroup.appendChild(xAxisLine);

            const yAxisLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            yAxisLine.setAttribute('x1', padding);
            yAxisLine.setAttribute('y1', padding);
            yAxisLine.setAttribute('x2', padding);
            yAxisLine.setAttribute('y2', height + padding);
            yAxisLine.setAttribute('stroke', '#e5e5e7');
            yAxisLine.setAttribute('stroke-width', '1');
            axisGroup.appendChild(yAxisLine);

            svg.appendChild(axisGroup);

            // Draw open tasks line
            let openPath = `M ${padding + (0 * width / 13)} ${height + padding - (openCounts[0] / maxOpen) * height}`;
            for (let i = 1; i < 14; i++) {
                openPath += ` L ${padding + (i * width / 13)} ${height + padding - (openCounts[i] / maxOpen) * height}`;
            }

            const openLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            openLine.setAttribute('d', openPath);
            openLine.setAttribute('stroke', '#007aff');
            openLine.setAttribute('stroke-width', '2');
            openLine.setAttribute('fill', 'none');
            svg.appendChild(openLine);

            // Draw created line
            let createdPath = `M ${padding + (0 * width / 13)} ${height + padding - (createdCounts[0] / maxOpen) * height}`;
            for (let i = 1; i < 14; i++) {
                createdPath += ` L ${padding + (i * width / 13)} ${height + padding - (createdCounts[i] / maxOpen) * height}`;
            }

            const createdLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            createdLine.setAttribute('d', createdPath);
            createdLine.setAttribute('stroke', '#ff9f0a');
            createdLine.setAttribute('stroke-width', '2');
            createdLine.setAttribute('fill', 'none');
            svg.appendChild(createdLine);

            // Y-axis labels
            for (let i = 0; i <= 4; i++) {
                const value = Math.round((maxOpen / 4) * i);
                const y = height + padding - (i / 4) * height;
                const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                label.setAttribute('x', padding - 8);
                label.setAttribute('y', y + 4);
                label.setAttribute('font-size', '11');
                label.setAttribute('fill', '#6e6e73');
                label.setAttribute('text-anchor', 'end');
                label.textContent = value;
                svg.appendChild(label);
            }

            // X-axis labels
            for (let i = 0; i < 14; i += 2) {
                const day = days[i];
                const x = padding + (i * width / 13);
                const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                label.setAttribute('x', x);
                label.setAttribute('y', height + padding + 20);
                label.setAttribute('font-size', '11');
                label.setAttribute('fill', '#6e6e73');
                label.setAttribute('text-anchor', 'middle');
                label.textContent = `${day.getMonth() + 1}/${day.getDate()}`;
                svg.appendChild(label);
            }

            // Legend
            const legendGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');

            const openRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            openRect.setAttribute('x', width + padding - 120);
            openRect.setAttribute('y', padding + 10);
            openRect.setAttribute('width', '8');
            openRect.setAttribute('height', '2');
            openRect.setAttribute('fill', '#007aff');
            legendGroup.appendChild(openRect);

            const openLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            openLabel.setAttribute('x', width + padding - 108);
            openLabel.setAttribute('y', padding + 14);
            openLabel.setAttribute('font-size', '11');
            openLabel.setAttribute('fill', '#6e6e73');
            openLabel.textContent = 'Open Tasks';
            legendGroup.appendChild(openLabel);

            const createdRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            createdRect.setAttribute('x', width + padding - 120);
            createdRect.setAttribute('y', padding + 26);
            createdRect.setAttribute('width', '8');
            createdRect.setAttribute('height', '2');
            createdRect.setAttribute('fill', '#ff9f0a');
            legendGroup.appendChild(createdRect);

            const createdLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            createdLabel.setAttribute('x', width + padding - 108);
            createdLabel.setAttribute('y', padding + 30);
            createdLabel.setAttribute('font-size', '11');
            createdLabel.setAttribute('fill', '#6e6e73');
            createdLabel.textContent = 'Total Created';
            legendGroup.appendChild(createdLabel);

            svg.appendChild(legendGroup);
        }


        async function addComment(taskId) {
            const input = document.getElementById('commentInput');
            const text = input ? input.value.trim() : '';
            if (!text || !githubToken) return;

            const task = tasks.find(t => t.id === taskId);
            if (!task) return;

            if (!task.comments) task.comments = [];
            task.comments.push({
                by: 'Christopher',
                text: text,
                timestamp: new Date().toISOString()
            });

            task.activity_log = task.activity_log || [];
            task.activity_log.push({
                timestamp: new Date().toISOString(),
                action: 'commented',
                by: 'Christopher',
                details: 'Added a comment'
            });

            await saveTasksToGithub(tasks);
            showTaskDetail(task);
        }

        function showEditTaskModal(taskId) {
            const task = tasks.find(t => t.id === taskId);
            if (!task || !githubToken) return;

            // Close detail modal
            document.getElementById('detailModal').classList.remove('active');

            // Set editing mode
            currentEditingTaskId = taskId;
            document.getElementById('modalTitle').textContent = 'Edit Task';
            document.getElementById('taskTitle').value = task.title || '';
            document.getElementById('taskDescription').value = task.description || '';
            document.getElementById('taskDueDate').value = task.due_date || '';
            document.getElementById('taskRecurrence').value = task.recurrence || '';

            // Set priority
            document.querySelectorAll('.priority-button').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.priority === String(task.priority));
            });

            // Set column
            const column = getTaskColumn(task);
            document.getElementById('taskColumn').value = column;

            // Set labels
            clearLabelTags();
            if (task.labels && task.labels.length > 0) {
                task.labels.forEach(label => {
                    if (label !== 'Parking Lot') {
                        addLabelTag(label);
                    }
                });
            }

            // Feature 10: Set delegation notes
            document.getElementById('taskDelegationNotes').value = task.delegation_notes || '';
            updateDelegationVisibility();

            // Set subtasks
            const subtasksContainer = document.getElementById('initialSubtasks');
            subtasksContainer.innerHTML = '';
            if (task.subtasks && task.subtasks.length > 0) {
                task.subtasks.forEach(subtask => {
                    const item = document.createElement('div');
                    item.className = 'subtask-item';
                    item.innerHTML = `
                        <input type="text" class="subtask-input" placeholder="Subtask title" value="${escapeHtml(subtask.title)}">
                        <button type="button" class="task-action-btn" style="width: auto; padding: 4px 8px;">Remove</button>
                    `;
                    item.querySelector('button').onclick = () => item.remove();
                    subtasksContainer.appendChild(item);
                });
            }

            document.getElementById('addTaskModal').classList.add('active');
        }

        // Event listeners
        document.getElementById('refreshBtn').onclick = loadTasks;
        document.getElementById('addTaskBtn').onclick = showAddTaskModal;
        document.getElementById('statsBtn').onclick = showStatsModal;

        // Feature 4: Activity feed button
        document.getElementById('activityBtn').onclick = showActivityFeed;
        document.getElementById('activityClose').onclick = () => {
            document.getElementById('activityModal').classList.remove('active');
        };

        // Feature 4: Activity filter buttons
        document.querySelectorAll('.activity-filter-btn').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.activity-filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                activityFilter = btn.dataset.filter;
                renderActivityFeed();
            };
        });

        // Feature 2: Timeline toggle
        document.getElementById('timelineBtn').onclick = toggleTimeline;
        document.getElementById('timelineClose').onclick = toggleTimeline;

        // Feature 8: Quick capture
        document.getElementById('quickCaptureInput').onkeypress = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                quickCapture();
            }
        };
        document.getElementById('quickCaptureBtn').onclick = quickCapture;
        // Keyboard shortcut: Cmd/Ctrl+K for quick capture
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                document.getElementById('quickCaptureInput').focus();
            }
            // Escape to clear batch selection
            if (e.key === 'Escape' && batchSelectedIds.length > 0) {
                clearBatchSelection();
            }
        });

        // Feature 10: Show/hide delegation notes based on column
        document.getElementById('taskColumn').onchange = updateDelegationVisibility;

        document.getElementById('addTaskClose').onclick = () => {
            document.getElementById('addTaskModal').classList.remove('active');
        };

        document.getElementById('addTaskCancel').onclick = () => {
            document.getElementById('addTaskModal').classList.remove('active');
        };

        document.getElementById('addTaskSave').onclick = saveTask;

        document.getElementById('detailClose').onclick = () => {
            document.getElementById('detailModal').classList.remove('active');
        };

        document.getElementById('statsClose').onclick = () => {
            document.getElementById('statsModal').classList.remove('active');
        };

        // Modal tabs
        document.querySelectorAll('.modal-tab').forEach(tab => {
            tab.onclick = () => {
                document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
                document.getElementById(tab.dataset.tab + 'Tab').classList.add('active');
            };
        });

        // Priority buttons
        document.querySelectorAll('.priority-button').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.priority-button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            };
        });

        // Label input
        document.getElementById('labelInput').onkeypress = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const value = document.getElementById('labelInput').value.trim();
                if (value) {
                    addLabelTag(value);
                }
            }
        };

        // Add subtask button
        document.getElementById('addSubtaskBtn').onclick = () => {
            const container = document.getElementById('initialSubtasks');
            const item = document.createElement('div');
            item.className = 'subtask-item';
            item.innerHTML = `
                <input type="text" class="subtask-input" placeholder="Subtask title">
                <button type="button" class="task-action-btn" style="width: auto; padding: 4px 8px;">Remove</button>
            `;
            item.querySelector('button').onclick = () => item.remove();
            container.appendChild(item);
        };

        // Search
        const searchInput = document.getElementById('searchInput');
        const searchClear = document.getElementById('searchClear');

        searchInput.oninput = () => {
            searchQuery = searchInput.value.trim();
            searchInput.classList.toggle('active', searchQuery.length > 0);
            filterTasks();
        };

        searchClear.onclick = () => {
            searchInput.value = '';
            searchInput.classList.remove('active');
            searchQuery = '';
            filterTasks();
        };

        // Sort
        document.getElementById('sortSelect').onchange = (e) => {
            currentSort = e.target.value;
            filterTasks();
        };

        // Priority filter
        document.getElementById('priorityFilter').onchange = (e) => {
            selectedPriority = e.target.value;
            e.target.classList.toggle('active', selectedPriority !== '');
            filterTasks();
        };

        // Owner filter
        document.getElementById('ownerFilter').onchange = (e) => {
            selectedOwner = e.target.value;
            e.target.classList.toggle('active', selectedOwner !== '');
            filterTasks();
        };

        // Modal backdrop click
        document.getElementById('addTaskModal').onclick = (e) => {
            if (e.target === document.getElementById('addTaskModal')) {
                document.getElementById('addTaskModal').classList.remove('active');
            }
        };

        document.getElementById('detailModal').onclick = (e) => {
            if (e.target === document.getElementById('detailModal')) {
                document.getElementById('detailModal').classList.remove('active');
            }
        };

        document.getElementById('statsModal').onclick = (e) => {
            if (e.target === document.getElementById('statsModal')) {
                document.getElementById('statsModal').classList.remove('active');
            }
        };

        // Initialize
        
        // ============================================
        // FEATURE 2: Timeline / Calendar Strip
        // ============================================
        function renderTimeline() {
            const container = document.getElementById('timelineDays');
            if (!container) return;
            container.innerHTML = '';

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // Collect tasks with due dates that are not completed
            const dueTasks = tasks.filter(t => t.due_date && t.status !== 'completed');
            if (dueTasks.length === 0) {
                container.innerHTML = '<div class="timeline-no-due">No upcoming deadlines</div>';
                return;
            }

            // Group by date, including overdue
            const groups = {};

            // Add overdue group
            const overdueTasks = dueTasks.filter(t => {
                const d = new Date(t.due_date);
                d.setHours(0, 0, 0, 0);
                return d < today;
            });
            if (overdueTasks.length > 0) {
                groups['overdue'] = { label: 'OVERDUE', tasks: overdueTasks, isOverdue: true };
            }

            // Add next 7 days
            for (let i = 0; i < 7; i++) {
                const date = new Date(today);
                date.setDate(date.getDate() + i);
                const key = date.toISOString().split('T')[0];
                const dayTasks = dueTasks.filter(t => t.due_date === key);
                if (dayTasks.length > 0 || i < 3) {
                    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                    const label = i === 0 ? 'TODAY' : i === 1 ? 'TOMORROW' : `${dayNames[date.getDay()]} ${date.getDate()}`;
                    groups[key] = { label, tasks: dayTasks, isToday: i === 0 };
                }
            }

            // Later tasks (>7 days out)
            const laterTasks = dueTasks.filter(t => {
                const d = new Date(t.due_date);
                d.setHours(0, 0, 0, 0);
                const diff = Math.floor((d - today) / 86400000);
                return diff > 7;
            });
            if (laterTasks.length > 0) {
                groups['later'] = { label: 'LATER', tasks: laterTasks };
            }

            Object.entries(groups).forEach(([key, group]) => {
                const dayEl = document.createElement('div');
                dayEl.className = 'timeline-day';
                if (group.isToday) dayEl.classList.add('today');
                if (group.isOverdue) dayEl.classList.add('overdue');

                const label = document.createElement('div');
                label.className = 'timeline-day-label';
                label.textContent = group.label + (group.tasks.length > 0 ? ` (${group.tasks.length})` : '');
                dayEl.appendChild(label);

                group.tasks.forEach(task => {
                    const taskEl = document.createElement('div');
                    taskEl.className = 'timeline-task';
                    const dot = document.createElement('span');
                    dot.className = 'priority-dot';
                    const colors = { 1: '#ff3b30', 2: '#ff9f0a', 3: '#34c759' };
                    dot.style.backgroundColor = colors[task.priority] || '#8e8e93';
                    taskEl.appendChild(dot);
                    const text = document.createElement('span');
                    text.textContent = task.title;
                    taskEl.appendChild(text);
                    taskEl.onclick = () => showTaskDetail(task);
                    dayEl.appendChild(taskEl);
                });

                if (group.tasks.length === 0) {
                    const empty = document.createElement('div');
                    empty.style.cssText = 'font-size:11px;color:#8e8e93;font-style:italic;padding:4px 0;';
                    empty.textContent = 'No tasks';
                    dayEl.appendChild(empty);
                }

                container.appendChild(dayEl);
            });
        }

        function toggleTimeline() {
            const strip = document.getElementById('timelineStrip');
            timelineVisible = !timelineVisible;
            strip.classList.toggle('visible', timelineVisible);
            if (timelineVisible) renderTimeline();
        }

        // ============================================
        // FEATURE 4: Global Activity Feed
        // ============================================
        function showActivityFeed() {
            document.getElementById('activityModal').classList.add('active');
            renderActivityFeed();
        }

        function renderActivityFeed() {
            const container = document.getElementById('activityFeed');
            if (!container) return;

            // Collect all activity entries across all tasks
            let allActivities = [];
            tasks.forEach(task => {
                (task.activity_log || []).forEach(entry => {
                    allActivities.push({
                        ...entry,
                        taskId: task.id,
                        taskTitle: task.title
                    });
                });
            });

            // Sort by timestamp descending
            allActivities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            // Filter
            if (activityFilter !== 'all') {
                allActivities = allActivities.filter(a => a.action === activityFilter);
            }

            // Limit to 50 most recent
            allActivities = allActivities.slice(0, 50);

            if (allActivities.length === 0) {
                container.innerHTML = '<div style="text-align:center;color:#8e8e93;padding:24px;">No activity found</div>';
                return;
            }

            const iconMap = {
                created: '➕',
                completed: '✓',
                moved: '→',
                edited: '✎',
                commented: '💬',
                attempted: '⚠',
                assigned: '👤',
                recurrence_spawned: '↻'
            };

            container.innerHTML = allActivities.map(a => `
                <div class="activity-item">
                    <div class="activity-icon ${a.action}">${iconMap[a.action] || '•'}</div>
                    <div class="activity-body">
                        <span class="activity-task-title" onclick="showTaskDetail(tasks.find(t => t.id === '${a.taskId}'))">${escapeHtml(a.taskTitle)}</span>
                        <div class="activity-detail">${escapeHtml(a.details)} — by ${escapeHtml(a.by)}</div>
                    </div>
                    <span class="activity-time">${getRelativeTime(a.timestamp)}</span>
                </div>
            `).join('');
        }

        // ============================================
        // FEATURE 7: Batch Actions
        // ============================================
        function toggleBatchSelect(taskId, cardEl) {
            const idx = batchSelectedIds.indexOf(taskId);
            if (idx >= 0) {
                batchSelectedIds.splice(idx, 1);
                cardEl.classList.remove('selected');
            } else {
                batchSelectedIds.push(taskId);
                cardEl.classList.add('selected');
            }
            updateBatchBar();
        }

        function updateBatchBar() {
            const bar = document.getElementById('batchBar');
            const count = document.getElementById('batchCount');
            if (batchSelectedIds.length > 0) {
                bar.classList.add('visible');
                count.textContent = batchSelectedIds.length;
            } else {
                bar.classList.remove('visible');
            }
        }

        function clearBatchSelection() {
            batchSelectedIds = [];
            document.querySelectorAll('.task-card.selected').forEach(el => el.classList.remove('selected'));
            updateBatchBar();
        }

        async function batchMove(targetColumn) {
            if (batchSelectedIds.length === 0 || !githubToken) return;

            const columnMapping = {
                'todo': { status: 'pending', mode: 'manual' },
                'christopher': { status: 'in_progress', mode: 'manual' },
                'claude': { status: 'in_progress', mode: 'auto' },
                'assistance': { status: 'in_progress', mode: 'assistance' },
                'completed': { status: 'completed', mode: null },
                'parking': { status: 'pending', mode: 'manual' }
            };
            const mapping = columnMapping[targetColumn];
            if (!mapping) return;

            batchSelectedIds.forEach(id => {
                const task = tasks.find(t => t.id === id);
                if (!task) return;
                const oldColumn = getTaskColumn(task);
                task.status = mapping.status;
                if (mapping.mode !== null) task.mode = mapping.mode;
                if (targetColumn === 'completed') task.completed_at = new Date().toISOString();
                if (targetColumn === 'parking' && !task.labels.includes('Parking Lot')) {
                    task.labels = task.labels || [];
                    task.labels.push('Parking Lot');
                } else if (targetColumn !== 'parking') {
                    task.labels = (task.labels || []).filter(l => l !== 'Parking Lot');
                }
                task.activity_log = task.activity_log || [];
                task.activity_log.push({
                    timestamp: new Date().toISOString(),
                    action: 'moved',
                    by: 'User',
                    details: 'Batch moved from ' + oldColumn + ' to ' + targetColumn
                });
            });

            await saveTasksToGithub(tasks);
            clearBatchSelection();
            await loadTasks();
        }

        // ============================================
        // FEATURE 8: Quick Capture
        // ============================================
        async function quickCapture() {
            const input = document.getElementById('quickCaptureInput');
            const title = input.value.trim();
            if (!title || !githubToken) return;

            const newTask = createTask(title, '', 2, [], 'todo', '', '', []);
            tasks.push(newTask);
            await saveTasksToGithub(tasks);
            input.value = '';
            await loadTasks();
        }

function init() {
            githubToken = getGithubToken();
            updateTokenStatus();
            loadTasks();

            // Auto-refresh
            setInterval(loadTasks, AUTO_REFRESH_INTERVAL);
        }

        init();
    