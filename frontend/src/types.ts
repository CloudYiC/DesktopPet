export type RepeatRule = 'none' | 'daily' | 'weekdays' | 'weekly';
export type ReminderPriority = 'normal' | 'important' | 'urgent';

export interface Reminder {
  id: number;
  title: string;
  dueAt: number;
  completed: boolean;
  notified: boolean;
  repeatRule: RepeatRule;
  priority: ReminderPriority;
}

export interface AppState {
  reminders: Reminder[];
  now: number;
  petName: string;
  soundEnabled: boolean;
  speechEnabled: boolean;
}

export interface HostMessage<T = unknown> {
  type: string;
  payload?: T;
}
