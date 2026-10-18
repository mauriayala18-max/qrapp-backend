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

/** The diner a seat-protected request acts as, proven by `requireSeat`. */
export interface SeatParticipant {
  id: string;
  session_id: string;
  user_id: string | null;
  web_name: string | null;
  platform: string | null;
}

/** Branch staff let through a seat-protected route that also serves staff. */
export interface SeatStaff {
  employeeId: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      /** Set by `requireSeat` - never derived from the request body. */
      participant?: SeatParticipant;
      /** Set by `requireSeat` when a route allows staff and the caller is one. */
      seatStaff?: SeatStaff;
    }
  }
}
