export interface UserProfile {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  date_of_birth: string | null;
  dining_frequency: string | null;
  preferred_language: string | null;
  font_size: string | null;
  dark_mode: boolean | null;
  registration_source: string | null;
  terms_accepted_at: string | null;
  terms_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmployeeProfile {
  id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  role: string;
  branch_ids: string[];
  is_active: boolean;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
