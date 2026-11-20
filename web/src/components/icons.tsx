import type { ReactNode } from 'react';

interface IconProps { intSize?: number; className?: string }

/** 24-unit outline icons drawn with the text color. boolSolid fills the shape instead. */
const icon = (objShape: ReactNode, boolSolid = false) =>
  function Icon({ intSize = 16, className }: IconProps) {
    return (
      <svg width={intSize} height={intSize} viewBox="0 0 24 24" aria-hidden="true" className={`shrink-0 ${className ?? ''}`}
        fill={boolSolid ? 'currentColor' : 'none'} stroke={boolSolid ? 'none' : 'currentColor'}
        strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        {objShape}
      </svg>
    );
  };

// ---- actions ----
export const IconPlay = icon(<path d="M7.5 4.6v14.8a.6.6 0 0 0 .9.5l11.8-7.4a.6.6 0 0 0 0-1L8.4 4.1a.6.6 0 0 0-.9.5z" />, true);
export const IconPlayAll = icon(
  <>
    <path d="M3 5.2v13.6a.5.5 0 0 0 .8.4l8.7-6.8a.5.5 0 0 0 0-.8L3.8 4.8a.5.5 0 0 0-.8.4z" />
    <path d="M12.5 5.2v13.6a.5.5 0 0 0 .8.4l8.7-6.8a.5.5 0 0 0 0-.8l-8.7-6.8a.5.5 0 0 0-.8.4z" />
  </>, true);
export const IconCalendar = icon(<><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>);
export const IconDownload = icon(<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />);
export const IconFilter = icon(<path d="M4 5.5h16l-6.2 7.3v5.4l-3.6 1.8v-7.2z" />);
export const IconStop = icon(<rect x="6" y="6" width="12" height="12" rx="2" />, true);
export const IconHistory = icon(<><path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5L4.5 8.5M4.5 4.5v4h4" /><path d="M12 8v4.5l3 1.8" /></>);
export const IconFormat = icon(<path d="M4 6h16M4 10.5h9M8 15h12M8 19.5h7" />);
export const IconComment = icon(<path d="M10.5 5 6.5 19M17.5 5l-4 14" />);
export const IconCheck = icon(<path d="M5 12.5 9.5 17 19 7.5" />);
export const IconUndo = icon(<path d="M8 5 4 9l4 4M4 9h10a5 5 0 0 1 0 10H9" />);
export const IconPlug = icon(<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />);
export const IconUnplug = icon(<path d="M9 3v3M15 3v5M18 8v3a6 6 0 0 1-.6 2.6M14.6 16.4A6 6 0 0 1 6 11V8h1M12 17v4M4 4l16 16" />);
export const IconRefresh = icon(<path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.3L20 15.5M20 20v-4.5h-4.5" />);
export const IconPlus = icon(<path d="M12 5v14M5 12h14" />);
export const IconClose = icon(<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />);
export const IconPencil = icon(<path d="M4 20l4.2-1L19.5 7.7a1.6 1.6 0 0 0 0-2.2l-1-1a1.6 1.6 0 0 0-2.2 0L5 15.8z" />);
export const IconTrash = icon(<path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5" />);
export const IconRows = icon(<path d="M4 6.5h16M4 12h16M4 17.5h16" />);
export const IconInfo = icon(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.6v.1" /></>);
export const IconSearch = icon(<><circle cx="11" cy="11" r="6" /><path d="m15.5 15.5 4.5 4.5" /></>);
export const IconSidebar = icon(<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9.5 4.5v15" /></>);
export const IconChevronRight =icon(<path d="m9.5 6 6 6-6 6" />);
export const IconChevronDown = icon(<path d="m6 9.5 6 6 6-6" />);

// ---- objects ----
export const IconDatabase = icon(
  <>
    <ellipse cx="12" cy="6" rx="7" ry="2.8" />
    <path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" />
  </>);
export const IconFolder = icon(<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />);
export const IconTable = icon(<><rect x="3.5" y="4.5" width="17" height="15" rx="1.5" /><path d="M3.5 9.5h17M9.5 9.5v10" /></>);
export const IconView = icon(
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.6" />
  </>);
export const IconFunction = icon(
  <path d="M8.5 4c-2 0-3 1-3 3v2c0 1.6-1 3-2.5 3 1.5 0 2.5 1.4 2.5 3v2c0 2 1 3 3 3M15.5 4c2 0 3 1 3 3v2c0 1.6 1 3 2.5 3-1.5 0-2.5 1.4-2.5 3v2c0 2-1 3-3 3" />);
export const IconSequence = icon(<path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16" />);
export const IconTrigger = icon(<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />);
export const IconPackage = icon(<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9" />);
export const IconKey = icon(<><circle cx="8" cy="15.5" r="4" /><path d="m11 12.5 8.5-8.5M16 7.5l3 3M13.5 10l2 2" /></>);
export const IconIndex = icon(<path d="M4 6.5h9M4 12h16M4 17.5h6" />);
export const IconLink = icon(
  <path d="M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" />);
export const IconColumn =icon(<circle cx="12" cy="12" r="2.6" />, true);
export const IconSqlFile = icon(<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20zM14 3.5v4h4M9.5 13h5M9.5 16.5h5" />);
