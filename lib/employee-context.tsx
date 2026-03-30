'use client'

import { createContext, useContext } from 'react'

export type Employee = {
  id:          string
  naam:        string
  functie:     string | null
  color:       string | null
  ghl_user_id: string | null
  calendar_id: string | null
}

type EmployeeCtx = {
  employees:         Employee[]
  activeEmployee:    Employee | null
  setActiveEmployee: (e: Employee) => void
}

const Ctx = createContext<EmployeeCtx>({
  employees:         [],
  activeEmployee:    null,
  setActiveEmployee: () => {},
})

export function useEmployee() {
  return useContext(Ctx)
}
