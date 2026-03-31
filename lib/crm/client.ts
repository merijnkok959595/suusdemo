/**
 * Native Supabase CRM client — no GHL dependency.
 * All writes go directly to Supabase and are immediately visible in the dashboard.
 * Multi-tenant: every query is scoped by organizationId (enforced here + by RLS).
 */

import { createAdminClient } from '@/utils/supabase/admin'
import type { Contact, CrmContext, Task, Appointment, BriefingData } from '@/lib/types'

// Re-export types so existing imports from '@/lib/crm/client' keep working.
export type { Contact, CrmContext, Task, Appointment, BriefingData }

// Alias kept for backward-compat with lib/crm/tools.ts imports.
// Single source of truth lives in utils/supabase/admin.ts.
export const adminSb = createAdminClient

export async function searchContacts(
  ctx:        CrmContext,
  query:      string,
  limit  = 10,
  tokens?: string[],       // pre-split tokens (overrides query if provided)
  city?:   string | null,  // AND filter for city
): Promise<Contact[]> {
  const FIELDS = 'id, first_name, last_name, company_name, type, industry, label, revenue, email, phone, address, address2, city, postcode, country, website, tags, status, assigned_to'
  let qb = adminSb()
    .from('contacts')
    .select(FIELDS)
    .eq('organization_id', ctx.organizationId)

  if (tokens && tokens.length > 0) {
    const orParts = tokens.flatMap(t => {
      const safe = t.replace(/[%_\\]/g, '\\$&')
      return [
        `first_name.ilike.%${safe}%`,
        `last_name.ilike.%${safe}%`,
        `company_name.ilike.%${safe}%`,
      ]
    })
    qb = qb.or(orParts.join(','))
  } else {
    const q = query.trim().replace(/[%_\\]/g, '\\$&')
    qb = qb.or(
      `first_name.ilike.%${q}%,last_name.ilike.%${q}%,company_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`
    )
  }

  if (city) {
    qb = qb.ilike('city', `%${city}%`)
  }

  const { data, error } = await qb.limit(limit)
  if (error) throw new Error(`contact_search: ${error.message}`)

  // If no contacts found in the contacts table, fall back to searching sub-account
  // organizations — this is the agency view where clients = organizations
  if ((data ?? []).length === 0) {
    return searchOrganizationsAsContacts(ctx.organizationId, query, tokens, limit)
  }

  return data as Contact[]
}

/**
 * Tier 2: trigram similarity search via Postgres pg_trgm.
 * Only called when ILIKE returns 0 results.
 * Uses the search_contacts_trgm() RPC function created in migration 038.
 */
export async function searchContactsTrgm(
  ctx:   CrmContext,
  query: string,
  limit = 10,
): Promise<Contact[]> {
  const FIELDS = 'id, first_name, last_name, company_name, type, industry, label, revenue, email, phone, address, address2, city, postcode, country, website, tags, status, assigned_to'
  const { data, error } = await adminSb().rpc('search_contacts_trgm', {
    p_org_id: ctx.organizationId,
    p_query:  query,
    p_limit:  limit,
  }).select(FIELDS)

  if (error) {
    // Gracefully degrade — trgm may not be available in all envs
    console.warn('[crm] trgm search unavailable:', error.message)
    return []
  }
  return (data ?? []) as Contact[]
}

/**
 * For agency-context users: their "contacts" are sub-account organizations.
 * Search the organizations table and map results to the Contact shape.
 * Excludes the agency's own org so it only returns client accounts.
 */
async function searchOrganizationsAsContacts(
  agencyOrgId: string,
  query:       string,
  tokens?:     string[],
  limit  = 10,
): Promise<Contact[]> {
  const sb  = adminSb()
  const raw = tokens?.join(' ') ?? query
  const q   = raw.trim().replace(/[%_\\]/g, '\\$&')
  if (!q) return []

  const { data } = await sb
    .from('organizations')
    .select('id, naam, contact_name, contact_email, slug, mrr, revenue_annual, label, industry')
    .neq('id', agencyOrgId)                    // exclude the agency itself
    .or(`naam.ilike.%${q}%,contact_name.ilike.%${q}%,contact_email.ilike.%${q}%`)
    .limit(limit)

  return ((data ?? []) as {
    id: string; naam: string | null; contact_name: string | null
    contact_email: string | null; slug: string | null
    label: string | null; industry: string | null
  }[]).map(o => {
    const nameParts = (o.contact_name ?? '').split(' ')
    return {
      id:            o.id,
      first_name:    nameParts[0] ?? null,
      last_name:     nameParts.slice(1).join(' ') || null,
      company_name:  o.naam,
      email:         o.contact_email ?? null,
      phone:         null,
      address:       null,
      address2:      null,
      city:          null,
      postcode:      o.industry ?? null,
      country:       null,
      website:       o.slug ? `(sub-account: ${o.slug})` : null,
      tags:          o.label ? [o.label] : [],
      type:          'customer',
      industry:      o.industry ?? null,
      label:         o.label ?? null,
      revenue:       null,
      status:        'customer',
      assigned_to:   null,
      last_activity: null,
      source:        null,
      channel:       null,
      opening_hours: null,
      custom_fields: null,
    } satisfies Contact
  })
}

// ─── Briefing data — parallel fetch of notes, tasks, appointments ──────────

export async function getContactBriefingData(
  ctx:       CrmContext,
  contactId: string,
): Promise<BriefingData> {
  const sb     = adminSb()
  const twoWeeksFromNow = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

  const [contactRes, notesRes, tasksRes, apptRes] = await Promise.all([
    sb.from('contacts')
      .select('id, first_name, last_name, company_name, email, phone, address, address2, city, postcode, country, website, tags, status, assigned_to')
      .eq('id', contactId)
      .eq('organization_id', ctx.organizationId)
      .single(),

    sb.from('notes')
      .select('body, created_at')
      .eq('contact_ref', contactId)
      .eq('organization_id', ctx.organizationId)
      .order('created_at', { ascending: false })
      .limit(5),

    sb.from('tasks')
      .select('title, body, due_date')
      .eq('contact_id', contactId)
      .eq('organization_id', ctx.organizationId)
      .eq('completed', false)
      .order('due_date', { ascending: true }),

    sb.from('appointments')
      .select('title, start_time, location')
      .eq('contact_id', contactId)
      .eq('organization_id', ctx.organizationId)
      .gte('start_time', new Date().toISOString())
      .lte('start_time', twoWeeksFromNow)
      .order('start_time', { ascending: true }),
  ])

  return {
    contact:      (contactRes.data ?? null) as Contact | null,
    notes:        (notesRes.data  ?? []) as { body: string | null; created_at: string }[],
    openTasks:    (tasksRes.data  ?? []) as { title: string; body: string | null; due_date: string | null }[],
    appointments: (apptRes.data   ?? []) as { title: string | null; start_time: string; location: string | null }[],
  }
}

/**
 * Check for potential duplicates before creating a contact.
 * Checks (in priority order):
 *   1. email exact match
 *   2. phone exact match (after stripping spaces/dashes)
 *   3. company_name + city fuzzy match
 *   4. first_name + last_name match
 */
export async function findContactDuplicates(
  ctx:    CrmContext,
  fields: { email?: string | null; phone?: string | null; first_name?: string | null; last_name?: string | null; company_name?: string | null; city?: string | null },
): Promise<Contact[]> {
  const sb = adminSb()
  const orParts: string[] = []

  if (fields.email?.trim()) {
    const e = fields.email.trim().replace(/[%_\\]/g, '\\$&')
    orParts.push(`email.ilike.${e}`)
  }

  const normalizedPhone = fields.phone ? fields.phone.replace(/[\s\-().]/g, '') : null
  if (normalizedPhone && normalizedPhone.length >= 7) {
    // Strip formatting and do a suffix match so +31612345678 matches 0612345678
    const phoneSuffix = normalizedPhone.slice(-9)
    orParts.push(`phone.ilike.%${phoneSuffix}%`)
  }

  if (orParts.length === 0 && !fields.company_name && !fields.last_name) return []

  let qb = sb.from('contacts')
    .select('id, first_name, last_name, company_name, email, phone, address, address2, city, postcode, country, website, tags, status, assigned_to')
    .eq('organization_id', ctx.organizationId)

  if (orParts.length > 0) {
    qb = qb.or(orParts.join(','))
  } else if (fields.company_name) {
    const co = fields.company_name.trim().replace(/[%_\\]/g, '\\$&')
    qb = qb.ilike('company_name', `%${co}%`)
    if (fields.city) qb = qb.ilike('city', `%${fields.city.trim()}%`)
  } else if (fields.last_name) {
    const ln = fields.last_name.trim().replace(/[%_\\]/g, '\\$&')
    qb = qb.ilike('last_name', `%${ln}%`)
    if (fields.first_name) {
      const fn = fields.first_name.trim().replace(/[%_\\]/g, '\\$&')
      qb = qb.ilike('first_name', `%${fn}%`)
    }
  }

  const { data } = await qb.limit(5)
  return (data ?? []) as Contact[]
}

export async function createContact(
  ctx:    CrmContext,
  fields: Partial<Omit<Contact, 'id' | 'tags' | 'status'>> & { tags?: string[] },
): Promise<Contact> {
  const { data, error } = await adminSb()
    .from('contacts')
    .insert({
      organization_id: ctx.organizationId,
      assigned_to:     fields.assigned_to ?? ctx.userId,
      ...fields,
    })
    .select('id, first_name, last_name, company_name, type, industry, label, revenue, email, phone, address, address2, city, postcode, country, website, tags, status, assigned_to')
    .single()

  if (error) throw new Error(`contact_create: ${error.message}`)
  return data as Contact
}

export async function updateContact(
  ctx:       CrmContext,
  contactId: string,
  fields:    Partial<Omit<Contact, 'id'>>,
): Promise<Contact> {
  const { data, error } = await adminSb()
    .from('contacts')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', contactId)
    .eq('organization_id', ctx.organizationId)   // tenant gate
    .select('id, first_name, last_name, company_name, type, industry, label, revenue, email, phone, address, address2, city, postcode, country, website, tags, status, assigned_to')
      .single()

  if (error) throw new Error(`contact_update: ${error.message}`)
  return data as Contact
}

// ─── Notes ─────────────────────────────────────────────────────────────────

export async function createNote(
  ctx:       CrmContext,
  contactId: string,
  body:      string,
): Promise<{ id: string }> {
  const { data, error } = await adminSb()
    .from('notes')
    .insert({
      organization_id: ctx.organizationId,
      contact_ref:     contactId,
      body,
      created_by:      ctx.userId,
    })
    .select('id')
    .single()

  if (error) throw new Error(`note_create: ${error.message}`)
  return data as { id: string }
}

// ─── Tasks ─────────────────────────────────────────────────────────────────

export async function createTask(
  ctx:       CrmContext,
  contactId: string,
  title:     string,
  body:      string,
  dueDate:   string,
): Promise<Task> {
  const { data, error } = await adminSb()
    .from('tasks')
    .insert({
      organization_id: ctx.organizationId,
      contact_id:      contactId,
      assigned_to:     ctx.userId,
      title,
      body,
      due_date:        dueDate,
      completed:       false,
    })
    .select('id, contact_id, title, body, due_date, completed, assigned_to')
    .single()

  if (error) throw new Error(`task_create: ${error.message}`)
  return data as Task
}

export async function listOpenTasks(
  ctx:   CrmContext,
  limit = 20,
): Promise<(Task & { contacts: { first_name: string | null; last_name: string | null; company_name: string | null } | null })[]> {
  const { data, error } = await adminSb()
    .from('tasks')
    .select('id, contact_id, title, body, due_date, completed, assigned_to, contacts(first_name, last_name, company_name)')
    .eq('organization_id', ctx.organizationId)
    .eq('completed', false)
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(limit)

  if (error) throw new Error(`task_list: ${error.message}`)
  return (data ?? []) as unknown as (Task & { contacts: { first_name: string | null; last_name: string | null; company_name: string | null } | null })[]
}

// ─── Appointments ──────────────────────────────────────────────────────────

export async function createAppointment(
  ctx:       CrmContext,
  contactId: string,
  title:     string,
  startTime: string,
  endTime:   string,
  location?: string,
  notes?:    string,
): Promise<Appointment> {
  const { data, error } = await adminSb()
    .from('appointments')
    .insert({
      organization_id: ctx.organizationId,
      contact_id:      contactId,
      assigned_to:     ctx.userId,
      title,
      start_time:      startTime,
      end_time:        endTime,
      location:        location ?? null,
      notes:           notes ?? null,
      status:          'confirmed',
    })
    .select('id, contact_id, title, start_time, end_time, status, location, notes')
    .single()

  if (error) throw new Error(`appointment_create: ${error.message}`)
  return data as Appointment
}

export async function listUpcomingAppointments(
  ctx:   CrmContext,
  limit = 10,
): Promise<(Appointment & { contacts: { first_name: string | null; last_name: string | null; company_name: string | null } | null })[]> {
  const sb = adminSb()
  const { data, error } = await sb
    .from('appointments')
    .select('id, contact_id, title, start_time, end_time, status, location, notes')
    .eq('organization_id', ctx.organizationId)
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true })
    .limit(limit)

  if (error) throw new Error(`appointment_list: ${error.message}`)
  const appts = data ?? []

  // Enrich with contact names via separate query (avoids PostgREST FK join issues)
  const contactIds = Array.from(new Set(appts.map(a => a.contact_id).filter(Boolean)))
  const { data: contacts } = contactIds.length
    ? await sb.from('contacts').select('id, first_name, last_name, company_name').in('id', contactIds)
    : { data: [] }
  const map = Object.fromEntries((contacts ?? []).map(c => [c.id, c]))

  return appts.map(a => ({ ...a, contacts: a.contact_id ? (map[a.contact_id] ?? null) : null })) as (Appointment & { contacts: { first_name: string | null; last_name: string | null; company_name: string | null } | null })[]
}
