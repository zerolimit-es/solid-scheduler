import React from 'react';
import {
  ShieldCheck as LucideShield,
  Calendar as LucideCalendar,
  Clock as LucideClock,
  Link as LucideLink,
  Check as LucideCheck,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  Download as LucideDownload,
  LogOut as LucideLogOut,
  User as LucideUser,
  Loader2 as LucideLoader,
  AlertCircle as LucideAlert,
  Repeat as LucideRepeat,
  XCircle as LucideCancel,
} from 'lucide-react';

const defaults = { size: 24, strokeWidth: 1.5 };

export const ShieldIcon = (p) => <LucideShield {...defaults} {...p} />;
export const CalendarIcon = (p) => <LucideCalendar {...defaults} {...p} />;
export const ClockIcon = (p) => <LucideClock {...defaults} {...p} />;
export const LinkIcon = (p) => <LucideLink {...defaults} {...p} />;
export const CheckIcon = (p) => <LucideCheck {...defaults} {...p} />;
export const ChevronLeftIcon = (p) => <LucideChevronLeft {...defaults} {...p} />;
export const ChevronRightIcon = (p) => <LucideChevronRight {...defaults} {...p} />;
export const DownloadIcon = (p) => <LucideDownload {...defaults} {...p} />;
export const LogOutIcon = (p) => <LucideLogOut {...defaults} {...p} />;
export const UserIcon = (p) => <LucideUser {...defaults} {...p} />;
export const LoaderIcon = (p) => <LucideLoader {...defaults} {...p} className={`animate-spin ${p.className || ''}`} />;
export const AlertIcon = (p) => <LucideAlert {...defaults} {...p} />;
export const RepeatIcon = (p) => <LucideRepeat {...defaults} {...p} />;
export const CancelIcon = (p) => <LucideCancel {...defaults} {...p} />;
