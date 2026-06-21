import { supabaseAdmin, supabaseAuth } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import type { UserProfile, EmployeeProfile } from "../../types/index.js";

export const registerUser = async (
  email: string,
  password: string,
  full_name: string,
  registration_source: string,
): Promise<{ user: UserProfile; session: { access_token: string; refresh_token: string } }> => {
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, registration_source },
  });

  if (authError || !authData.user) {
    throw createError(authError?.message ?? "Registration failed", 400, "REGISTRATION_FAILED");
  }

  const userId = authData.user.id;

  const { error: profileError } = await supabaseAdmin
    .from("users")
    .insert({
      id: userId,
      email,
      full_name,
      registration_source,
    });

  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw createError(profileError.message, 400, "PROFILE_CREATION_FAILED");
  }

  const { data: signInData, error: signInError } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });

  if (signInError || !signInData) {
    throw createError("Failed to generate session", 500, "SESSION_CREATION_FAILED");
  }

  const { data: sessionData, error: sessionError } =
    await supabaseAdmin.auth.admin.getUserById(userId);

  if (sessionError) {
    throw createError("Failed to retrieve user", 500, "USER_RETRIEVAL_FAILED");
  }

  const { data: profile, error: fetchError } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", userId)
    .single();

  if (fetchError || !profile) {
    throw createError("Failed to fetch profile", 500, "PROFILE_FETCH_FAILED");
  }

  const { data: tokenData, error: tokenError } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });

  void tokenData;

  if (tokenError) {
    throw createError("Session generation failed", 500, "TOKEN_ERROR");
  }

  const { data: passwordSignIn, error: passwordSignInError } =
    await supabaseAuth.auth.signInWithPassword({ email, password });

  if (passwordSignInError || !passwordSignIn.session) {
    throw createError("Failed to create session after registration", 500, "SESSION_FAILED");
  }

  return {
    user: profile as UserProfile,
    session: {
      access_token: passwordSignIn.session.access_token,
      refresh_token: passwordSignIn.session.refresh_token,
    },
  };
};

export const loginUser = async (
  email: string,
  password: string,
): Promise<{
  user: UserProfile;
  session: { access_token: string; refresh_token: string };
  needs_terms_acceptance: boolean;
}> => {
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    throw createError(error?.message ?? "Login failed", 401, "LOGIN_FAILED");
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", data.user.id)
    .single();

  if (profileError || !profile) {
    throw createError("User profile not found", 404, "PROFILE_NOT_FOUND");
  }

  const CURRENT_TERMS_VERSION = "1.0";
  const needs_terms_acceptance =
    !profile.terms_version || profile.terms_version !== CURRENT_TERMS_VERSION;

  return {
    user: profile as UserProfile,
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    },
    needs_terms_acceptance,
  };
};

export const socialLogin = async (
  provider: "google" | "apple",
  access_token: string,
): Promise<{ user: UserProfile; session: { access_token: string; refresh_token: string } }> => {
  const { data, error } = await supabaseAuth.auth.signInWithIdToken({
    provider,
    token: access_token,
  });

  if (error || !data.session) {
    throw createError(error?.message ?? "Social login failed", 401, "SOCIAL_LOGIN_FAILED");
  }

  const userId = data.user.id;
  const email = data.user.email ?? "";
  const full_name =
    (data.user.user_metadata?.["full_name"] as string) ??
    (data.user.user_metadata?.["name"] as string) ??
    null;

  const { data: existing } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("id", userId)
    .maybeSingle();

  if (!existing) {
    await supabaseAdmin.from("users").insert({
      id: userId,
      email,
      full_name,
      registration_source: provider,
    });
  } else {
    await supabaseAdmin
      .from("users")
      .update({ email, full_name })
      .eq("id", userId);
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", userId)
    .single();

  if (profileError || !profile) {
    throw createError("Failed to fetch user profile", 500, "PROFILE_FETCH_FAILED");
  }

  return {
    user: profile as UserProfile,
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    },
  };
};

export const getMe = async (userId: string): Promise<UserProfile> => {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", userId)
    .single();

  if (error || !data) {
    throw createError("User not found", 404, "USER_NOT_FOUND");
  }

  return data as UserProfile;
};

export const updateMe = async (
  userId: string,
  updates: Partial<{
    full_name: string;
    phone: string;
    date_of_birth: string;
    dining_frequency: string;
    preferred_language: string;
    font_size: string;
    dark_mode: boolean;
  }>,
): Promise<UserProfile> => {
  const { data, error } = await supabaseAdmin
    .from("users")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", userId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Update failed", 400, "UPDATE_FAILED");
  }

  return data as UserProfile;
};

export const employeeLogin = async (
  email: string,
  password: string,
): Promise<{
  employee: EmployeeProfile;
  session: { access_token: string; refresh_token: string };
}> => {
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    throw createError(error?.message ?? "Login failed", 401, "LOGIN_FAILED");
  }

  const userId = data.user.id;

  const { data: employee, error: empError } = await supabaseAdmin
    .from("employees")
    .select("*")
    .eq("auth_user_id", userId)
    .eq("is_active", true)
    .single();

  if (empError || !employee) {
    throw createError("Employee not found or inactive", 403, "EMPLOYEE_NOT_FOUND");
  }

  const { data: branches, error: branchError } = await supabaseAdmin
    .from("employee_branches")
    .select("branch_id")
    .eq("employee_id", employee.id);

  if (branchError) {
    throw createError("Failed to fetch branch assignments", 500, "BRANCH_FETCH_FAILED");
  }

  const branch_ids = (branches ?? []).map(
    (b: { branch_id: string }) => b.branch_id,
  );

  return {
    employee: {
      id: employee.id as string,
      user_id: userId,
      email,
      full_name: employee.full_name as string | null,
      role: employee.role as string,
      branch_ids,
      is_active: true,
    },
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    },
  };
};

export const acceptTerms = async (
  userId: string,
  version: string,
): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("users")
    .update({
      terms_accepted_at: new Date().toISOString(),
      terms_version: version,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (error) {
    throw createError(error.message, 400, "TERMS_UPDATE_FAILED");
  }
};
