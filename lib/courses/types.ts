export type CourseItem = { id?: string; title: string; kind: 'assignment' | 'exam' | 'topic'; due: string | null; weight: string; details: string; sourceId: string | null; status: 'todo' | 'doing' | 'done' };
export type CourseDraft = { name: string; term: string; instructor: string; schedule: string; officeHours: string; items: CourseItem[] };
export type Course = { id: string; name: string; instructions: string; course_data: CourseDraft | null; syllabus_id: string | null; updated_at: string };
export type CourseFile = { id: string; name: string; status: string; project_id: string | null };
export type CourseChat = { id: string; title: string; project_id: string; provider: string; orbit_mode: boolean };
export type CourseLaunch = { course: Course; item?: CourseItem; prompt: string; provider: string; conversationId?: string };
