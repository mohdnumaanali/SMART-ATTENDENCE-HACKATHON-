const API_BASE = window.location.port === '5500' ? 'http://localhost:3000/api' : '/api';
const TOKEN_KEY = 'sru_token';
const USER_KEY = 'sru_user';
const SYNC_KEY = 'sru_attendance_sync';
const LATE_REASONS = ['Bus/Traffic', 'Medical', 'Prev. Class', 'Other'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let barChart = null;
let currentReportData = null;
let currentStudentData = null;
let markingRows = [];
let studentSyncTimer = null;

// Escape HTML to keep table rendering safe
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getTodayDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Format YYYY-MM-DD as DD-MM-YYYY (Day), e.g. 14-11-2026 (Sat)
function formatDisplayDate(isoDate) {
  const parts = String(isoDate || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return esc(isoDate);
  const [y, m, d] = parts;
  const dayName = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y} (${dayName})`;
}

// Format YYYY-MM-DD as DD-MM-YYYY, e.g. 13-11-2026
function formatShortDate(isoDate) {
  const parts = String(isoDate || '').split('-');
  if (parts.length !== 3) return esc(isoDate);
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

// Show a brief message in the bottom-right corner
function showMessage(text, isError = false) {
  const box = document.getElementById('message-box');
  box.textContent = text;
  box.className = `message-box ${isError ? 'is-error' : 'is-success'}`;
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => {
    box.classList.add('is-hidden');
  }, 3200);
}

// Helper for calling backend /api/* endpoints with JWT token
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store', ...options, headers });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) {
      logout();
    }
    throw new Error(data.message || 'Request failed');
  }
  return data;
}

// Download table rows as a CSV file
function exportCsv(filename, columns, rows) {
  const cleanCell = (v) => {
    let text = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const headerLine = columns.map((c) => cleanCell(c.label)).join(',');
  const bodyLines = rows.map((r) => columns.map((c) => cleanCell(r[c.key])).join(','));
  const csvContent = [headerLine, ...bodyLines].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

/* -------------------- Session & Navigation -------------------- */

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  stopStudentSync();
  if (barChart) {
    barChart.destroy();
    barChart = null;
  }
  showView('auth');
}

function stopStudentSync() {
  if (studentSyncTimer) {
    clearInterval(studentSyncTimer);
    studentSyncTimer = null;
  }
}

function showOnlySection(sectionId) {
  const sections = ['view-auth', 'view-admin', 'view-faculty-mark', 'view-faculty-report', 'view-student'];
  sections.forEach((id) => {
    document.getElementById(id).classList.toggle('is-hidden', id !== sectionId);
  });
}

function renderNavbar(user, activeView) {
  const topbar = document.getElementById('topbar');
  const nav = document.getElementById('topbar-nav');
  const userLabel = document.getElementById('topbar-user');

  if (!user) {
    topbar.classList.add('is-hidden');
    return;
  }

  topbar.classList.remove('is-hidden');
  userLabel.textContent = `${user.userId} (${user.role})`;

  const tabsByRole = {
    Admin: [{ id: 'admin', label: 'Course & Enrollment' }],
    Faculty: [
      { id: 'faculty-mark', label: 'Mark Attendance' },
      { id: 'faculty-report', label: 'Reports & Analytics' },
    ],
    Student: [{ id: 'student', label: 'My Attendance' }],
  };

  const tabs = tabsByRole[user.role] || [];
  nav.innerHTML = tabs
    .map((t) => `<button type="button" class="nav-btn ${t.id === activeView ? 'is-active' : ''}" data-view="${t.id}">${t.label}</button>`)
    .join('');

  nav.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
}

async function showView(view) {
  const user = getCurrentUser();
  if (!user || view === 'auth') {
    stopStudentSync();
    renderNavbar(null);
    showOnlySection('view-auth');
    return;
  }

  // Enforce role access on views
  if (view === 'admin' && user.role !== 'Admin') return showView('faculty-mark');
  if ((view === 'faculty-mark' || view === 'faculty-report') && user.role !== 'Faculty') {
    return showView(user.role === 'Admin' ? 'admin' : 'student');
  }
  if (view === 'student' && user.role !== 'Student') {
    return showView(user.role === 'Admin' ? 'admin' : 'faculty-mark');
  }

  if (view !== 'student') {
    stopStudentSync();
  }

  renderNavbar(user, view);
  showOnlySection(`view-${view}`);

  if (view === 'admin') await loadAdminPage();
  if (view === 'faculty-mark') await loadFacultyMarkPage(user);
  if (view === 'faculty-report') await loadFacultyReportPage(user);
  if (view === 'student') await loadStudentPage(user);
}

function enterHomeForRole(user) {
  if (user.role === 'Admin') showView('admin');
  else if (user.role === 'Faculty') showView('faculty-mark');
  else showView('student');
}

/* -------------------- Module 1: Login & Register -------------------- */

function setupAuth() {
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');
  const loginError = document.getElementById('login-error');
  const registerError = document.getElementById('register-error');

  tabLogin.addEventListener('click', () => {
    tabLogin.classList.add('is-active');
    tabRegister.classList.remove('is-active');
    formLogin.classList.remove('is-hidden');
    formRegister.classList.add('is-hidden');
    loginError.classList.add('is-hidden');
  });

  tabRegister.addEventListener('click', () => {
    tabRegister.classList.add('is-active');
    tabLogin.classList.remove('is-active');
    formRegister.classList.remove('is-hidden');
    formLogin.classList.add('is-hidden');
    registerError.classList.add('is-hidden');
  });

  // 3 demo fill buttons populate ID, password, and role
  document.querySelectorAll('[data-fill-role]').forEach((btn) => {
    btn.addEventListener('click', () => {
      tabLogin.click();
      document.getElementById('login-role').value = btn.dataset.fillRole;
      document.getElementById('login-id').value = btn.dataset.fillId;
      document.getElementById('login-password').value = 'Password@123';
      loginError.classList.add('is-hidden');
    });
  });

  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.classList.add('is-hidden');
    try {
      const data = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          identifier: document.getElementById('login-id').value.trim(),
          password: document.getElementById('login-password').value,
          role: document.getElementById('login-role').value,
        }),
      });
      saveSession(data.token, data.user);
      showMessage(`Logged in as ${data.user.name}`);
      enterHomeForRole(data.user);
    } catch (err) {
      loginError.textContent = err.message;
      loginError.classList.remove('is-hidden');
    }
  });

  formRegister.addEventListener('submit', async (e) => {
    e.preventDefault();
    registerError.classList.add('is-hidden');
    try {
      const data = await apiFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          userId: document.getElementById('reg-id').value.trim(),
          name: document.getElementById('reg-name').value.trim(),
          email: document.getElementById('reg-email').value.trim(),
          password: document.getElementById('reg-password').value,
          role: document.getElementById('reg-role').value,
        }),
      });
      saveSession(data.token, data.user);
      showMessage(`Account created for ${data.user.name}`);
      enterHomeForRole(data.user);
    } catch (err) {
      registerError.textContent = err.message;
      registerError.classList.remove('is-hidden');
    }
  });
}

/* -------------------- Module 2: Admin Management -------------------- */

let adminInitialized = false;

function setupAdmin() {
  if (adminInitialized) return;
  adminInitialized = true;

  document.getElementById('form-add-user').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          role: document.getElementById('adm-user-role').value,
          userId: document.getElementById('adm-user-id').value.trim(),
          name: document.getElementById('adm-user-name').value.trim(),
          email: document.getElementById('adm-user-email').value.trim(),
          password: document.getElementById('adm-user-pw').value,
        }),
      });
      showMessage(`Added ${res.user.role}: ${res.user.userId}`);
      e.target.reset();
      document.getElementById('adm-user-pw').value = 'Password@123';
      await loadAdminPage();
    } catch (err) {
      showMessage(err.message, true);
    }
  });

  document.getElementById('form-add-course').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/courses/add', {
        method: 'POST',
        body: JSON.stringify({
          courseId: document.getElementById('adm-course-id').value.trim(),
          courseName: document.getElementById('adm-course-name').value.trim(),
          facultyId: document.getElementById('adm-course-fac').value,
        }),
      });
      showMessage(res.message);
      e.target.reset();
      await loadAdminPage();
    } catch (err) {
      showMessage(err.message, true);
    }
  });

  document.getElementById('form-assign-faculty').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/courses/assignFaculty', {
        method: 'POST',
        body: JSON.stringify({
          courseId: document.getElementById('adm-assign-course').value,
          facultyId: document.getElementById('adm-assign-fac').value,
        }),
      });
      showMessage(res.message);
      await loadAdminPage();
    } catch (err) {
      showMessage(err.message, true);
    }
  });

  document.getElementById('form-enroll-student').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/courses/enrollStudent', {
        method: 'POST',
        body: JSON.stringify({
          studentId: document.getElementById('adm-enroll-student').value,
          courseId: document.getElementById('adm-enroll-course').value,
        }),
      });
      showMessage(res.message);
      await loadAdminPage();
    } catch (err) {
      showMessage(err.message, true);
    }
  });
}

async function loadAdminPage() {
  setupAdmin();
  try {
    const [students, faculty, courses] = await Promise.all([
      apiFetch('/users?role=Student'),
      apiFetch('/users?role=Faculty'),
      apiFetch('/courses'),
    ]);

    const facOptions = faculty.map((f) => `<option value="${esc(f.userId)}">${esc(f.userId)} - ${esc(f.name)}</option>`).join('');
    document.getElementById('adm-course-fac').innerHTML = `<option value="">Unassigned</option>${facOptions}`;
    document.getElementById('adm-assign-fac').innerHTML = facOptions;

    const courseOptions = courses.map((c) => `<option value="${esc(c.courseId)}">${esc(c.courseId)} - ${esc(c.courseName)}</option>`).join('');
    document.getElementById('adm-assign-course').innerHTML = courseOptions;
    document.getElementById('adm-enroll-course').innerHTML = courseOptions;

    document.getElementById('adm-enroll-student').innerHTML = students
      .map((s) => {
        const meta = s.department
          ? ` (${s.department}${s.semester ? ` · Sem ${s.semester}-${s.section}` : ''})`
          : '';
        return `<option value="${esc(s.userId)}">${esc(s.userId)} - ${esc(s.name)}${esc(meta)}</option>`;
      })
      .join('');

    const tbody = document.getElementById('tbody-admin-courses');
    if (!courses.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No courses found.</td></tr>';
      return;
    }

    tbody.innerHTML = courses
      .map(
        (c) => `
      <tr>
        <td class="code-text">${esc(c.courseId)}</td>
        <td><strong>${esc(c.courseName)}</strong></td>
        <td>${c.facultyName ? `${esc(c.facultyName)} <span class="code-text">(${esc(c.facultyId)})</span>` : '<span class="badge badge-neutral">Unassigned</span>'}</td>
        <td class="num">${c.enrolledCount}</td>
      </tr>`
      )
      .join('');
  } catch (err) {
    showMessage(err.message, true);
  }
}

/* -------------------- Module 3: Faculty Attendance Marking -------------------- */

let markInitialized = false;
let activeSlot = 'Slot I (09:30-10:30)';

function setupFacultyMark() {
  if (markInitialized) return;
  markInitialized = true;

  const courseSelect = document.getElementById('mark-course');
  const dateInput = document.getElementById('mark-date');
  const startTimeInput = document.getElementById('mark-start-time');
  const topicInput = document.getElementById('mark-topic');
  const topicCount = document.getElementById('mark-topic-count');

  dateInput.value = getTodayDate();

  courseSelect.addEventListener('change', loadCourseRoster);
  dateInput.addEventListener('change', loadCourseRoster);
  document.getElementById('enrolled-search').addEventListener('input', renderEnrolledStudentsList);

  // Period slot pill selection updates Scheduled Start Time & row Check-In times
  document.querySelectorAll('#mark-period-slots .slot-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#mark-period-slots .slot-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      activeSlot = btn.textContent.trim();
      document.getElementById('mark-slot-label').textContent = `${btn.dataset.slot} (1 Hour)`;
      startTimeInput.value = btn.dataset.start;
      markingRows.forEach((row) => {
        if (row.status !== 'Absent') {
          row.checkInTime = btn.dataset.start;
        }
      });
      renderMarkingTable();
    });
  });

  startTimeInput.addEventListener('change', () => {
    const newStart = startTimeInput.value || '09:30';
    markingRows.forEach((row) => {
      if (row.status === 'Present') {
        row.checkInTime = newStart;
      }
    });
    renderMarkingTable();
  });

  topicInput.addEventListener('input', () => {
    topicCount.textContent = `${topicInput.value.length} / 150 chars`;
  });

  document.getElementById('btn-all-present').addEventListener('click', () => {
    const defaultTime = startTimeInput.value || '09:30';
    markingRows.forEach((row) => {
      row.status = 'Present';
      row.lateReason = '';
      row.checkInTime = defaultTime;
    });
    renderMarkingTable();
  });

  document.getElementById('btn-all-absent').addEventListener('click', () => {
    markingRows.forEach((row) => {
      row.status = 'Absent';
      row.lateReason = '';
      row.checkInTime = '';
    });
    renderMarkingTable();
  });

  document.getElementById('btn-submit-attendance').addEventListener('click', async () => {
    const courseId = courseSelect.value;
    const date = dateInput.value;
    if (!courseId || !date || !markingRows.length) return;

    const sessionType = document.querySelector('input[name="session-type"]:checked')?.value || 'Lecture';
    const topic = topicInput.value.trim();

    try {
      const res = await apiFetch('/attendance/mark', {
        method: 'POST',
        body: JSON.stringify({
          courseId,
          date,
          period: activeSlot,
          sessionType,
          topic,
          records: markingRows.map((r) => ({
            studentId: r.studentId,
            status: r.status,
            lateReason: r.status === 'Late' ? r.lateReason : '',
            checkInTime: r.status === 'Absent' ? '' : r.checkInTime,
          })),
        }),
      });
      showMessage(res.message);
      document.getElementById('mark-note').classList.remove('is-hidden');
      localStorage.setItem(SYNC_KEY, String(Date.now()));
      await loadCourseRoster();
    } catch (err) {
      showMessage(err.message, true);
    }
  });
}

async function loadFacultyMarkPage(user) {
  setupFacultyMark();
  try {
    const courses = await apiFetch(`/courses/faculty/${user.userId}`);
    const select = document.getElementById('mark-course');

    if (!courses.length) {
      select.innerHTML = '<option value="">No assigned courses</option>';
      markingRows = [];
      renderMarkingTable();
      renderEnrolledStudentsList();
      return;
    }

    select.innerHTML = courses
      .map((c) => `<option value="${esc(c.courseId)}">${esc(c.courseId)} — ${esc(c.courseName)}</option>`)
      .join('');

    await loadCourseRoster();
  } catch (err) {
    showMessage(err.message, true);
  }
}

async function loadCourseRoster() {
  const courseId = document.getElementById('mark-course').value;
  const date = document.getElementById('mark-date').value || getTodayDate();
  const note = document.getElementById('mark-note');
  const defaultTime = document.getElementById('mark-start-time').value || '09:30';

  if (!courseId) {
    markingRows = [];
    renderMarkingTable();
    renderEnrolledStudentsList();
    return;
  }

  try {
    const data = await apiFetch(`/attendance/course/${courseId}?date=${encodeURIComponent(date)}`);
    note.classList.toggle('is-hidden', !data.alreadyMarked);

    const topicInput = document.getElementById('mark-topic');
    if (data.sessionMeta) {
      topicInput.value = data.sessionMeta.topic || '';
      document.getElementById('mark-topic-count').textContent = `${topicInput.value.length} / 150 chars`;
      if (data.sessionMeta.sessionType) {
        const radio = document.querySelector(`input[name="session-type"][value="${data.sessionMeta.sessionType}"]`);
        if (radio) radio.checked = true;
      }
      if (data.sessionMeta.period) {
        const matchingSlot = [...document.querySelectorAll('#mark-period-slots .slot-btn')].find(
          (b) => b.textContent.trim() === data.sessionMeta.period
        );
        if (matchingSlot) {
          document.querySelectorAll('#mark-period-slots .slot-btn').forEach((b) => b.classList.remove('is-active'));
          matchingSlot.classList.add('is-active');
          activeSlot = matchingSlot.textContent.trim();
          document.getElementById('mark-slot-label').textContent = `${matchingSlot.dataset.slot} (1 Hour)`;
        }
      }
    } else {
      topicInput.value = '';
      document.getElementById('mark-topic-count').textContent = '0 / 150 chars';
    }

    markingRows = data.students.map((s) => ({
      studentId: s.studentId,
      name: s.name,
      email: s.email || '',
      department: s.department || '',
      semester: s.semester ?? null,
      section: s.section || '',
      isActive: s.isActive !== false,
      cumulativePercentage: s.cumulativePercentage ?? 100,
      status: s.status || 'Present',
      lateReason: s.status === 'Late' ? (s.lateReason || LATE_REASONS[0]) : '',
      checkInTime: s.status === 'Absent' ? '' : s.checkInTime || defaultTime,
    }));
    renderMarkingTable();
    renderEnrolledStudentsList();
  } catch (err) {
    showMessage(err.message, true);
  }
}

function renderEnrolledStudentsList() {
  const courseId = document.getElementById('mark-course').value;
  const badge = document.getElementById('enrolled-course-badge');
  const tbody = document.getElementById('tbody-enrolled-students');
  const query = (document.getElementById('enrolled-search')?.value || '').trim().toLowerCase();

  badge.textContent = courseId
    ? `${courseId} — ${markingRows.length} Enrolled`
    : '0 Enrolled';

  const filtered = markingRows.filter((s) => {
    if (!query) return true;
    return (
      s.studentId.toLowerCase().includes(query) ||
      s.name.toLowerCase().includes(query) ||
      s.department.toLowerCase().includes(query)
    );
  });

  if (!filtered.length) {
    const emptyMsg = markingRows.length
      ? 'No enrolled students match your search.'
      : 'No students enrolled in this course.';
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">${emptyMsg}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((s, idx) => {
      const semSec = s.semester ? `Sem ${s.semester}${s.section ? ` - ${s.section}` : ''}` : '-';
      const activeBadge =
        s.isActive === false
          ? '<span class="badge badge-neutral">Inactive</span>'
          : '<span class="badge badge-safe">Active</span>';
      return `
      <tr>
        <td class="num">${idx + 1}</td>
        <td class="code-text"><strong>${esc(s.studentId)}</strong></td>
        <td>${esc(s.name)}</td>
        <td>${esc(s.department || '-')}</td>
        <td>${esc(semSec)}</td>
        <td class="code-text">${esc(s.email || '-')}</td>
        <td>${activeBadge}</td>
      </tr>`;
    })
    .join('');
}

function renderMarkingTable() {
  const tbody = document.getElementById('tbody-mark');
  const submitBtn = document.getElementById('btn-submit-attendance');
  const defaultTime = document.getElementById('mark-start-time').value || '09:30';

  if (!markingRows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No students enrolled in this course.</td></tr>';
    submitBtn.disabled = true;
    updateMarkSummary();
    return;
  }

  submitBtn.disabled = false;
  tbody.innerHTML = markingRows
    .map((row, idx) => {
      const reasonHtml =
        row.status === 'Late'
          ? `<select class="reason-select" data-reason-idx="${idx}" aria-label="Late reason for ${esc(row.name)}">
              ${LATE_REASONS.map((r) => `<option value="${esc(r)}" ${row.lateReason === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
            </select>`
          : '';

      const metaParts = [];
      if (row.department) metaParts.push(esc(row.department));
      if (row.semester) metaParts.push(`Sem ${row.semester}${row.section ? `-${esc(row.section)}` : ''}`);
      const metaHtml = metaParts.length ? `<span class="student-meta">${metaParts.join(' · ')}</span>` : '';
      const inactiveHtml = row.isActive === false ? '<span class="badge-inactive">Inactive</span>' : '';

      return `
      <tr class="${row.status === 'Late' ? 'row-late' : ''}">
        <td class="num">${idx + 1}</td>
        <td class="code-text"><strong>${esc(row.studentId)}</strong></td>
        <td>${esc(row.name)}${inactiveHtml}${metaHtml}</td>
        <td class="num">${Number(row.cumulativePercentage).toFixed(1)}%</td>
        <td>
          <input type="time" class="time-input" data-time-idx="${idx}" value="${esc(row.checkInTime)}" ${row.status === 'Absent' ? 'disabled' : ''} aria-label="Check-in time for ${esc(row.name)}" />
        </td>
        <td>
          <div class="status-cell-wrap">
            <div class="status-group">
              <button type="button" class="status-btn ${row.status === 'Present' ? 'active-Present' : ''}" data-idx="${idx}" data-status="Present">Present</button>
              <button type="button" class="status-btn ${row.status === 'Late' ? 'active-Late' : ''}" data-idx="${idx}" data-status="Late">Late</button>
              <button type="button" class="status-btn ${row.status === 'Absent' ? 'active-Absent' : ''}" data-idx="${idx}" data-status="Absent">Absent</button>
            </div>
            ${reasonHtml}
          </div>
        </td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('.status-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const status = btn.dataset.status;
      markingRows[idx].status = status;
      markingRows[idx].lateReason = status === 'Late' ? (markingRows[idx].lateReason || LATE_REASONS[0]) : '';
      markingRows[idx].checkInTime = status === 'Absent' ? '' : (markingRows[idx].checkInTime || defaultTime);
      renderMarkingTable();
    });
  });

  tbody.querySelectorAll('.time-input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const idx = Number(inp.dataset.timeIdx);
      markingRows[idx].checkInTime = inp.value;
    });
  });

  tbody.querySelectorAll('.reason-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const idx = Number(sel.dataset.reasonIdx);
      markingRows[idx].lateReason = sel.value;
    });
  });

  updateMarkSummary();
}

function updateMarkSummary() {
  document.getElementById('cnt-total').textContent = markingRows.length;
  document.getElementById('cnt-present').textContent = markingRows.filter((r) => r.status === 'Present').length;
  document.getElementById('cnt-late').textContent = markingRows.filter((r) => r.status === 'Late').length;
  document.getElementById('cnt-absent').textContent = markingRows.filter((r) => r.status === 'Absent').length;
}

/* -------------------- Module 4A: Faculty Reports & Chart -------------------- */

let facultyReportInitialized = false;

function setupFacultyReport() {
  if (facultyReportInitialized) return;
  facultyReportInitialized = true;

  document.getElementById('report-course').addEventListener('change', loadSelectedCourseReport);

  document.getElementById('btn-faculty-csv').addEventListener('click', () => {
    if (!currentReportData) return;
    const rows = currentReportData.students.map((s) => ({
      studentId: s.studentId,
      name: s.name,
      attendedTotal: `${s.attended} / ${s.total}`,
      percentage: `${s.percentage}%`,
      status: s.percentage < 75 ? '<75% Defaulter' : 'Safe',
    }));
    exportCsv(
      `${currentReportData.course.courseId}-report.csv`,
      [
        { key: 'studentId', label: 'Roll Number' },
        { key: 'name', label: 'Student Name' },
        { key: 'attendedTotal', label: 'Attended / Total' },
        { key: 'percentage', label: 'Percentage' },
        { key: 'status', label: 'Status' },
      ],
      rows
    );
  });

  document.getElementById('btn-faculty-print').addEventListener('click', () => window.print());
}

async function loadFacultyReportPage(user) {
  setupFacultyReport();
  try {
    const courses = await apiFetch(`/courses/faculty/${user.userId}`);
    const select = document.getElementById('report-course');
    if (!courses.length) {
      select.innerHTML = '<option value="">No assigned courses</option>';
      return;
    }
    select.innerHTML = courses
      .map((c) => `<option value="${esc(c.courseId)}">${esc(c.courseId)} - ${esc(c.courseName)}</option>`)
      .join('');
    await loadSelectedCourseReport();
  } catch (err) {
    showMessage(err.message, true);
  }
}

async function loadSelectedCourseReport() {
  const courseId = document.getElementById('report-course').value;
  if (!courseId) return;

  try {
    const report = await apiFetch(`/attendance/report/${courseId}`);
    currentReportData = report;

    document.getElementById('report-chart-title').textContent =
      `${report.course.courseId} (${report.course.courseName}) — Student Attendance (%)`;
    document.getElementById('frep-sessions').textContent = report.summary.totalSessions;
    document.getElementById('frep-students').textContent = report.summary.totalStudents;
    document.getElementById('frep-avg').textContent = `${report.summary.averagePercentage}%`;
    document.getElementById('frep-defaulters').textContent = report.summary.defaultersCount;

    const tbody = document.getElementById('tbody-faculty-report');
    if (!report.students.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No students enrolled.</td></tr>';
    } else {
      tbody.innerHTML = report.students
        .map((s) => {
          const isDefaulter = s.total > 0 && s.percentage < 75;
          const metaParts = [];
          if (s.department) metaParts.push(esc(s.department));
          if (s.semester) metaParts.push(`Sem ${s.semester}${s.section ? `-${esc(s.section)}` : ''}`);
          const metaHtml = metaParts.length ? `<span class="student-meta">${metaParts.join(' · ')}</span>` : '';
          const inactiveHtml = s.isActive === false ? '<span class="badge-inactive">Inactive</span>' : '';
          return `
          <tr>
            <td class="code-text">${esc(s.studentId)}</td>
            <td><strong>${esc(s.name)}</strong>${inactiveHtml}${metaHtml}</td>
            <td class="num">${s.attended} / ${s.total}</td>
            <td class="num"><strong>${s.percentage}%</strong></td>
            <td>
              <span class="badge ${isDefaulter ? 'badge-defaulter' : 'badge-safe'}">
                ${isDefaulter ? '&lt;75% Defaulter' : 'Safe'}
              </span>
            </td>
          </tr>`;
        })
        .join('');
    }

    renderBarChart(report.students);
  } catch (err) {
    showMessage(err.message, true);
  }
}

function renderBarChart(students) {
  if (barChart) {
    barChart.destroy();
    barChart = null;
  }
  if (typeof Chart === 'undefined') return;

  const canvas = document.getElementById('faculty-bar-chart');
  barChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: students.map((s) => s.studentId),
      datasets: [
        {
          label: 'Attendance %',
          data: students.map((s) => s.percentage),
          backgroundColor: students.map((s) => (s.percentage < 75 ? '#dc2626' : '#1e3a8a')),
          borderRadius: 4,
          maxBarThickness: 44,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          min: 0,
          max: 100,
          ticks: { callback: (val) => `${val}%` },
          grid: { color: '#e2e8f0' },
        },
        x: {
          grid: { display: false },
        },
      },
      plugins: {
        legend: { display: false },
      },
    },
  });
}

/* -------------------- Module 4B: Student My Attendance -------------------- */

let studentInitialized = false;

function getLastWeekRows() {
  if (!currentStudentData) return [];
  const byDate = new Map();
  for (const row of currentStudentData.recentHistory) {
    let entry = byDate.get(row.date);
    if (!entry) {
      entry = { date: row.date, held: 0, attend: 0 };
      byDate.set(row.date, entry);
    }
    entry.held += row.held ?? 1;
    entry.attend += row.attended ?? (row.status === 'Absent' ? 0 : 1);
  }
  return [...byDate.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 7);
}

function renderLastWeekTable() {
  const tbody = document.getElementById('tbody-student-lastweek');
  const rows = getLastWeekRows();
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No attendance records found.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(
      (r, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>
          <button type="button" class="date-link" data-week-date="${esc(r.date)}" title="Filter Day-Wise Attendance by ${formatShortDate(r.date)}">
            ${formatShortDate(r.date)}
          </button>
        </td>
        <td>${r.held}</td>
        <td>${r.attend}</td>
      </tr>`
    )
    .join('');

  tbody.querySelectorAll('.date-link').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('stu-filter-course').value = '';
      document.getElementById('stu-filter-date').value = btn.dataset.weekDate;
      renderStudentDayWise();
    });
  });
}

function getFilteredDayWiseRows() {
  if (!currentStudentData) return [];
  const courseFilter = document.getElementById('stu-filter-course').value;
  const dateFilter = document.getElementById('stu-filter-date').value;
  return currentStudentData.recentHistory.filter((row) => {
    if (courseFilter && row.courseId !== courseFilter) return false;
    if (dateFilter && row.date !== dateFilter) return false;
    return true;
  });
}

function renderStudentDayWise() {
  const tbody = document.getElementById('tbody-student-daywise');
  const rows = getFilteredDayWiseRows();
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No attendance records match the selected filters.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((h, idx) => {
      const badgeClass =
        h.status === 'Present' ? 'badge-present' : h.status === 'Late' ? 'badge-late' : 'badge-absent';
      const statusLabel = h.lateReason ? `${esc(h.status)} (${esc(h.lateReason)})` : esc(h.status);
      return `
      <tr>
        <td class="num">${idx + 1}</td>
        <td class="code-text">${formatDisplayDate(h.date)}</td>
        <td><span class="code-text">${esc(h.courseId)}</span> — ${esc(h.courseName)}</td>
        <td class="num">${h.held ?? 1}</td>
        <td class="num">${h.attended ?? (h.status === 'Absent' ? 0 : 1)}</td>
        <td class="num">${h.late ?? (h.status === 'Late' ? 1 : 0)}</td>
        <td class="num"><strong>${h.dailyPct ?? (h.status === 'Absent' ? 0 : 100)}%</strong></td>
        <td><span class="badge ${badgeClass}">${statusLabel}</span></td>
      </tr>`;
    })
    .join('');
}

function exportCombinedStudentCsv() {
  if (!currentStudentData) return;
  const cleanCell = (v) => {
    let text = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [];
  lines.push(['SR University Attendance Slip', currentStudentData.studentId].map(cleanCell).join(','));
  lines.push('');

  lines.push('LAST WEEK ATTENDANCE %');
  lines.push(['S.No', 'Date', 'Held', 'Attend'].map(cleanCell).join(','));
  getLastWeekRows().forEach((r, idx) => {
    lines.push([idx + 1, formatShortDate(r.date), r.held, r.attend].map(cleanCell).join(','));
  });
  lines.push('');

  lines.push('DAY-WISE ATTENDANCE');
  lines.push(['#', 'Date', 'Course', 'Held', 'Attended', 'Late', 'Daily %', 'Status'].map(cleanCell).join(','));
  const dayRows = getFilteredDayWiseRows();
  dayRows.forEach((h, idx) => {
    lines.push(
      [
        idx + 1,
        formatDisplayDate(h.date),
        `${h.courseId} - ${h.courseName}`,
        h.held ?? 1,
        h.attended ?? (h.status === 'Absent' ? 0 : 1),
        h.late ?? (h.status === 'Late' ? 1 : 0),
        `${h.dailyPct ?? (h.status === 'Absent' ? 0 : 100)}%`,
        h.lateReason ? `${h.status} (${h.lateReason})` : h.status,
      ]
        .map(cleanCell)
        .join(',')
    );
  });

  lines.push('');
  lines.push('SUBJECT-WISE BREAKDOWN');
  lines.push(
    ['#', 'Course Code & Title', 'Faculty In-Charge', 'Type', 'Held', 'Attended', 'Attendance %', 'Status', 'Deficit to 75%']
      .map(cleanCell)
      .join(',')
  );
  currentStudentData.courses.forEach((c, idx) => {
    const isShortage = c.total > 0 && c.percentage < 75;
    const deficit = c.classesNeededFor75 ?? 0;
    const courseType =
      c.courseType || (c.courseId.startsWith('MC') ? 'Mandatory' : /lab/i.test(c.courseName) ? 'Practical Lab' : 'Theory');
    const deficitLabel = isShortage && deficit > 0 ? `+${deficit} ${deficit === 1 ? 'class' : 'classes'}` : 'None';
    lines.push(
      [
        idx + 1,
        `${c.courseId} — ${c.courseName}`,
        c.facultyName,
        courseType,
        c.total,
        c.attended,
        `${Number(c.percentage).toFixed(1)}%`,
        isShortage ? 'Shortage' : 'Safe',
        deficitLabel,
      ]
        .map(cleanCell)
        .join(',')
    );
  });

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${currentStudentData.studentId}-attendance-slip.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

// Generate a valid multi-page PDF 1.4 document using standard built-in fonts
function buildPdfBlob(drawPages) {
  const safeText = (s) =>
    String(s == null ? '' : s)
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');

  const pages = [];
  let cmds = [];
  let y = 800;

  const newPage = () => {
    if (cmds.length) pages.push(cmds.join('\n'));
    cmds = [];
    y = 800;
  };

  const ensureSpace = (needed = 16) => {
    if (y - needed < 42) newPage();
  };

  const addText = (text, x, size = 9, font = 'F1', rgb = [0.12, 0.16, 0.23]) => {
    cmds.push(
      `${rgb[0].toFixed(3)} ${rgb[1].toFixed(3)} ${rgb[2].toFixed(3)} rg BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${safeText(text)}) Tj ET`
    );
  };

  const addLine = (x1, x2, lineY, rgb = [0.82, 0.85, 0.89], width = 0.6) => {
    cmds.push(
      `${width} w ${rgb[0].toFixed(3)} ${rgb[1].toFixed(3)} ${rgb[2].toFixed(3)} RG ${x1} ${lineY} m ${x2} ${lineY} l S`
    );
  };

  const addRect = (x, rectY, w, h, rgb) => {
    cmds.push(`${rgb[0].toFixed(3)} ${rgb[1].toFixed(3)} ${rgb[2].toFixed(3)} rg ${x} ${rectY} ${w} ${h} re f`);
  };

  drawPages({
    get y() { return y; },
    set y(val) { y = val; },
    newPage,
    ensureSpace,
    addText,
    addLine,
    addRect,
  });

  if (cmds.length) pages.push(cmds.join('\n'));

  // Build PDF objects: 1=Catalog, 2=Pages, 3..6=Fonts, then pairs of (Page, ContentStream)
  const objects = [];
  const pageObjNums = [];
  const firstPageObj = 7;

  pages.forEach((_, i) => {
    pageObjNums.push(firstPageObj + i * 2);
  });

  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`);
  objects.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  objects.push('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n');
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n');
  objects.push('6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>\nendobj\n');

  pages.forEach((stream, i) => {
    const pageObj = firstPageObj + i * 2;
    const contentObj = pageObj + 1;
    objects.push(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`
    );
    objects.push(
      `${contentObj} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`
    );
  });

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new Blob([pdf], { type: 'application/pdf' });
}

function downloadStudentPdf() {
  if (!currentStudentData) {
    showMessage('Attendance data is still loading.', true);
    return;
  }

  const user = getCurrentUser() || {};
  const o = currentStudentData.overall || {};
  const isShortage = o.total > 0 && o.percentage < 75;
  const pad = (val, len) => String(val ?? '').slice(0, len).padEnd(len, ' ');
  const padL = (val, len) => String(val ?? '').slice(0, len).padStart(len, ' ');

  const blob = buildPdfBlob((ctx) => {
    // Top Navy Banner
    ctx.addRect(36, 782, 523, 36, [0.118, 0.227, 0.541]);
    ctx.y = 804;
    ctx.addText('SR UNIVERSITY - SMART ATTENDANCE TRACKER', 48, 12, 'F2', [1, 1, 1]);
    ctx.y = 790;
    ctx.addText('Official Student Attendance Statement (75% Eligibility Report)', 48, 9, 'F1', [0.86, 0.92, 1]);

    // Student Identity & Summary
    ctx.y = 762;
    const deptMeta = [
      user.department || '',
      user.semester ? `Sem ${user.semester}${user.section ? `-${user.section}` : ''}` : '',
    ]
      .filter(Boolean)
      .join(' | ');
    ctx.addText(`Student: ${user.name || currentStudentData.studentId} (${currentStudentData.studentId})`, 36, 10, 'F2');
    ctx.y -= 14;
    ctx.addText(
      `${deptMeta ? `${deptMeta}   |   ` : ''}Generated: ${formatDisplayDate(getTodayDate())}`,
      36,
      9,
      'F1',
      [0.39, 0.45, 0.55]
    );

    ctx.y -= 10;
    ctx.addLine(36, 559, ctx.y);
    ctx.y -= 16;
    ctx.addText(`Overall Attendance: ${Number(o.percentage || 0).toFixed(1)}%`, 36, 10, 'F2');
    ctx.addText(`Attended: ${o.attended || 0} / ${o.total || 0}`, 215, 10, 'F2');
    ctx.addText(`Courses: ${currentStudentData.courses.length}`, 350, 10, 'F2');
    ctx.addText(
      `Standing: ${isShortage ? 'Shortage (<75%)' : 'Safe'}`,
      440,
      10,
      'F2',
      isShortage ? [0.86, 0.15, 0.15] : [0.08, 0.5, 0.24]
    );

    // 1. Last Week Attendance %
    ctx.y -= 24;
    ctx.addText('1. Last Week Attendance %', 36, 11, 'F2', [0.118, 0.227, 0.541]);
    ctx.y -= 14;
    ctx.addText(`${pad('S.No', 6)}${pad('Date', 16)}${padL('Held', 8)}${padL('Attend', 10)}`, 36, 8.5, 'F4');
    ctx.y -= 4;
    ctx.addLine(36, 559, ctx.y);
    getLastWeekRows().forEach((r, idx) => {
      ctx.ensureSpace(18);
      ctx.y -= 13;
      ctx.addText(
        `${pad(idx + 1, 6)}${pad(formatShortDate(r.date), 16)}${padL(r.held, 8)}${padL(r.attend, 10)}`,
        36,
        8.5,
        'F3'
      );
    });

    // 2. Subject-Wise Breakdown
    ctx.y -= 22;
    ctx.ensureSpace(45);
    ctx.addText('2. Subject-Wise Breakdown', 36, 11, 'F2', [0.118, 0.227, 0.541]);
    ctx.y -= 14;
    ctx.addText(
      `${pad('#', 3)}${pad('Code', 8)}${pad('Course Title', 26)}${pad('Type', 14)}${padL('Held', 5)}${padL('Att', 5)}${padL('%', 7)}  ${pad('Status', 9)}${pad('Deficit', 11)}`,
      36,
      8,
      'F4'
    );
    ctx.y -= 4;
    ctx.addLine(36, 559, ctx.y);
    currentStudentData.courses.forEach((c, idx) => {
      ctx.ensureSpace(18);
      ctx.y -= 13;
      const short = c.total > 0 && c.percentage < 75;
      const deficit = c.classesNeededFor75 ?? 0;
      const courseType =
        c.courseType || (c.courseId.startsWith('MC') ? 'Mandatory' : /lab/i.test(c.courseName) ? 'Practical Lab' : 'Theory');
      const deficitLabel = short && deficit > 0 ? `+${deficit} cls` : 'None';
      const rowColor = short ? [0.75, 0.12, 0.12] : [0.12, 0.16, 0.23];
      ctx.addText(
        `${pad(idx + 1, 3)}${pad(c.courseId, 8)}${pad(c.courseName, 25)} ${pad(courseType, 14)}${padL(c.total, 5)}${padL(c.attended, 5)}${padL(`${Number(c.percentage).toFixed(1)}%`, 7)}  ${pad(short ? 'Shortage' : 'Safe', 9)}${pad(deficitLabel, 11)}`,
        36,
        8,
        'F3',
        rowColor
      );
    });

    // 3. Day-Wise Attendance
    ctx.y -= 22;
    ctx.ensureSpace(45);
    ctx.addText('3. Day-Wise Attendance Log', 36, 11, 'F2', [0.118, 0.227, 0.541]);
    ctx.y -= 14;
    ctx.addText(
      `${pad('#', 4)}${pad('Date', 17)}${pad('Code', 8)}${pad('Course Title', 28)}${padL('Held', 5)}${padL('Att', 5)}${padL('Late', 5)}  ${pad('Status', 16)}`,
      36,
      8,
      'F4'
    );
    ctx.y -= 4;
    ctx.addLine(36, 559, ctx.y);
    const dayRows = getFilteredDayWiseRows();
    dayRows.forEach((h, idx) => {
      ctx.ensureSpace(18);
      ctx.y -= 13;
      const stLabel = h.lateReason ? `${h.status} (${h.lateReason})` : h.status;
      const rowColor = h.status === 'Absent' ? [0.75, 0.12, 0.12] : [0.12, 0.16, 0.23];
      ctx.addText(
        `${pad(idx + 1, 4)}${pad(formatDisplayDate(h.date), 17)}${pad(h.courseId, 8)}${pad(h.courseName, 27)} ${padL(h.held ?? 1, 5)}${padL(h.attended ?? (h.status === 'Absent' ? 0 : 1), 5)}${padL(h.late ?? (h.status === 'Late' ? 1 : 0), 5)}  ${pad(stLabel, 16)}`,
        36,
        8,
        'F3',
        rowColor
      );
    });
  });

  const filename = `${currentStudentData.studentId}-attendance-report.pdf`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
  showMessage(`Downloaded ${filename}`);
}

function setupStudent() {
  if (studentInitialized) return;
  studentInitialized = true;

  document.getElementById('stu-filter-course').addEventListener('change', renderStudentDayWise);
  document.getElementById('stu-filter-date').addEventListener('change', renderStudentDayWise);
  document.getElementById('btn-stu-clear-filters').addEventListener('click', () => {
    document.getElementById('stu-filter-course').value = '';
    document.getElementById('stu-filter-date').value = '';
    renderStudentDayWise();
  });

  document.getElementById('btn-student-csv').addEventListener('click', exportCombinedStudentCsv);
  document.getElementById('btn-student-print').addEventListener('click', downloadStudentPdf);

  // Live sync across tabs & window focus when Faculty submits new attendance
  window.addEventListener('storage', (e) => {
    if (e.key === SYNC_KEY) {
      const u = getCurrentUser();
      if (u && u.role === 'Student' && !document.getElementById('view-student').classList.contains('is-hidden')) {
        loadStudentPage(u);
      }
    }
  });
  window.addEventListener('focus', () => {
    const u = getCurrentUser();
    if (u && u.role === 'Student' && !document.getElementById('view-student').classList.contains('is-hidden')) {
      loadStudentPage(u);
    }
  });
}

async function loadStudentPage(user) {
  setupStudent();

  if (!studentSyncTimer) {
    studentSyncTimer = setInterval(() => {
      const u = getCurrentUser();
      if (u && u.role === 'Student' && !document.getElementById('view-student').classList.contains('is-hidden')) {
        loadStudentPage(u);
      }
    }, 10000);
  }

  try {
    const [enrolledCourses, data] = await Promise.all([
      apiFetch(`/courses/student/${user.userId}`),
      apiFetch(`/attendance/student/${user.userId}`),
    ]);
    currentStudentData = data;

    // Populate Subject filter while preserving active filter selection
    const courseSel = document.getElementById('stu-filter-course');
    const prevCourse = courseSel.value;
    courseSel.innerHTML =
      '<option value="">All Subjects</option>' +
      enrolledCourses.map((c) => `<option value="${esc(c.courseId)}">${esc(c.courseId)} — ${esc(c.courseName)}</option>`).join('');
    if ([...courseSel.options].some((o) => o.value === prevCourse)) {
      courseSel.value = prevCourse;
    }

    const o = data.overall;
    const isOverallDefaulter = o.total > 0 && o.percentage < 75;
    const profileMeta = [
      user.department || '',
      user.semester ? `Sem ${user.semester}${user.section ? `-${user.section}` : ''}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    document.getElementById('student-summary-line').textContent =
      `${user.name} (${user.userId})${profileMeta ? ` — ${profileMeta}` : ''} — Statutory 75% Attendance Statement`;
    document.getElementById('stu-stat-pct').textContent = `${o.percentage}%`;
    document.getElementById('stu-stat-attended').textContent = `${o.attended} / ${o.total}`;
    document.getElementById('stu-stat-courses').textContent = enrolledCourses.length;
    const standingEl = document.getElementById('stu-stat-standing');
    standingEl.textContent = isOverallDefaulter ? '<75% Defaulter' : 'Safe';
    standingEl.className = `stat-value ${isOverallDefaulter ? 'text-danger' : 'text-safe'}`;

    renderLastWeekTable();
    renderStudentDayWise();

    const tbody = document.getElementById('tbody-student-report');
    if (!data.courses.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-cell">No enrolled courses found.</td></tr>';
    } else {
      tbody.innerHTML = data.courses
        .map((c, idx) => {
          const isShortage = c.total > 0 && c.percentage < 75;
          const deficit = c.classesNeededFor75 ?? 0;
          const courseType =
            c.courseType ||
            (c.courseId.startsWith('MC') ? 'Mandatory' : /lab/i.test(c.courseName) ? 'Practical Lab' : 'Theory');
          const statusClass = isShortage ? 'text-danger' : 'text-safe';
          const deficitLabel =
            isShortage && deficit > 0 ? `+${deficit} ${deficit === 1 ? 'class' : 'classes'}` : 'None';
          return `
          <tr>
            <td>${idx + 1}</td>
            <td><strong>${esc(c.courseId)}</strong> — ${esc(c.courseName)}</td>
            <td>${esc(c.facultyName)}</td>
            <td>${esc(courseType)}</td>
            <td class="num">${c.total}</td>
            <td class="num">${c.attended}</td>
            <td class="num"><strong class="${statusClass}">${Number(c.percentage).toFixed(1)}%</strong></td>
            <td><strong class="${statusClass}">${isShortage ? 'Shortage' : 'Safe'}</strong></td>
            <td><strong class="${statusClass}">${deficitLabel}</strong></td>
          </tr>`;
        })
        .join('');
    }
  } catch (err) {
    showMessage(err.message, true);
  }
}

/* -------------------- App Boot -------------------- */

document.getElementById('btn-signout').addEventListener('click', () => {
  logout();
  showMessage('Signed out');
});

setupAuth();

(async function start() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    showView('auth');
    return;
  }
  try {
    const res = await apiFetch('/auth/me');
    saveSession(token, res.user);
    enterHomeForRole(res.user);
  } catch {
    logout();
  }
})();
