# Problem Statement 1: Smart Attendance Tracker

A role-based web application built with **HTML5, CSS3, JavaScript, Node.js, Express.js, and MongoDB (Mongoose)** that automates classroom attendance tracking, course enrollment, and 75% attendance reporting.

## Folder Structure

```
project/
├── backend/
│   ├── models/
│   │   ├── User.js
│   │   ├── Course.js
│   │   ├── Enrollment.js
│   │   └── Attendance.js
│   ├── routes/
│   │   ├── auth.routes.js
│   │   ├── course.routes.js
│   │   └── attendance.routes.js
│   ├── seed.js
│   ├── server.js
│   └── package.json
└── frontend/
    ├── index.html
    ├── style.css
    └── script.js
```

## Database Design

| Collection | Fields |
|---|---|
| **Users** | `userId`, `name`, `role` (`Admin` / `Faculty` / `Student`), `email`, `password` (bcrypt), `department`, `semester`, `section`, `isActive` |
| **Courses** | `courseId`, `courseName`, `facultyId` |
| **Enrollments** | `studentId`, `courseId` (unique compound index) |
| **Attendance** | `attendanceId`, `courseId`, `studentId`, `date`, `status` (`Present` / `Late` / `Absent`), `lateReason`, `checkInTime`, `period`, `sessionType`, `topic` |

## API Routes (10 Core Endpoints + Utilities)

| Purpose | Route | Method | Role |
|---|---|---|---|
| Register / Login | `/api/auth/register`, `/api/auth/login` | `POST` | All |
| Create Course | `/api/courses/add` | `POST` | Admin |
| Assign Faculty to Course | `/api/courses/assignFaculty` | `POST` | Admin |
| Enroll Student | `/api/courses/enrollStudent` | `POST` | Admin |
| Mark Attendance | `/api/attendance/mark` | `POST` | Faculty |
| Get Attendance (Faculty View) | `/api/attendance/course/:courseId` | `GET` | Faculty |
| Get Attendance (Student View) | `/api/attendance/student/:studentId` | `GET` | Student |
| Generate Report | `/api/attendance/report/:courseId` | `GET` | Faculty |
| Fetch Courses by Faculty | `/api/courses/faculty/:facultyId` | `GET` | Faculty |
| Fetch Courses by Student | `/api/courses/student/:studentId` | `GET` | Student |

Additional helper endpoints: `GET /api/health`, `GET /api/auth/me`, `GET /api/users` (Admin), `GET /api/courses` (Admin), `GET /api/courses/enrollments` (Admin).

## Demo Credentials (Password: `Password@123`)

- **Admin**: `ADMIN001`
- **Faculty**: `FAC001`, `FAC002`
- **Students**: 100 seeded students (`CS23001` – `EC23018`, e.g., `CS23001`)

## Setup & Run Locally

### Option 1: Standalone Backend + VS Code Live Server (`127.0.0.1:5500`)
```bash
cd backend
npm install
node seed.js
node server.js
```
Then open `frontend/index.html` with VS Code Live Server (`http://127.0.0.1:5500`).

### Option 2: Unified Server (Port 3000)
```bash
npm install
npm run dev
```

## PPT Outline & Demo Flow (Deliverables Guide)

1. **Problem & Objective**: Eliminates paper attendance inefficiency with role-based automation for Admin, Faculty, and Students.
2. **System Architecture & Flow**: HTML/CSS/JS Frontend -> Express REST API with JWT & Role Middleware -> Mongoose / MongoDB.
3. **Database Schema**: 4 collections (`Users`, `Courses`, `Enrollments`, `Attendance`) with compound unique indexes preventing duplicate enrollments and duplicate date entries.
4. **10 API Endpoints**: Auth (`register`, `login`), Admin setup (`add`, `assignFaculty`, `enrollStudent`), Faculty marking/reporting (`mark`, `course/:courseId`, `report/:courseId`, `faculty/:facultyId`), and Student views (`student/:studentId` for attendance & courses).
5. **Live Demo Script**:
   - Login as **Admin** (`ADMIN001`) -> Add user, create course, assign faculty, enroll student.
   - Login as **Faculty** (`FAC001`) -> Select assigned course & date, mark Present/Late/Absent, submit attendance, view Bar Chart & `<75% Defaulter` report, export CSV / Print PDF.
   - Login as **Student** (`SRU2024001`) -> View course-wise percentages, attendance history table, and download CSV / PDF summary.
