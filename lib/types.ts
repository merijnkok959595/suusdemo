export type CrmContext = {
  organizationId: string
  userId:         string
  userNaam:       string
}

export type Contact = {
  id:            string
  first_name:    string | null
  last_name:     string | null
  company_name:  string | null
  type:          string | null
  industry:      string | null
  label:         string | null
  revenue:       number | null
  email:         string | null
  phone:         string | null
  address:       string | null
  address2:      string | null
  city:          string | null
  postcode:      string | null
  country:       string | null
  website:       string | null
  tags:          string[] | null
  status:        string | null
  assigned_to:   string | null
  last_activity: string | null
  source:        string | null
  channel:       string | null
  opening_hours: string | null
  custom_fields: Record<string, unknown> | null
}

export type Task = {
  id:          string
  contact_id:  string | null
  title:       string
  body:        string | null
  due_date:    string | null
  completed:   boolean
  assigned_to: string | null
}

export type Appointment = {
  id:          string
  contact_id:  string | null
  title:       string | null
  start_time:  string
  end_time:    string
  status:      string | null
  location:    string | null
  notes:       string | null
}

export type BriefingData = {
  contact:      Contact | null
  notes:        { body: string | null; created_at: string }[]
  openTasks:    { title: string; body: string | null; due_date: string | null }[]
  appointments: { title: string | null; start_time: string; location: string | null }[]
}
