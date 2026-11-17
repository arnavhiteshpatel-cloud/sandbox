/** Hand-drawn icon set: 24px grid, 1.6px strokes, rounded caps — consistent and quiet. */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 22): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
});

export const IconTimer = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="12" cy="13.5" r="7.5" />
    <path d="M12 9.5v4l2.5 1.5M9.5 2.75h5M12 2.75V6" />
  </svg>
);
export const IconList = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <circle cx="4.5" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="17.5" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);
export const IconChart = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M3.5 19.5h17" />
    <path d="M5.5 15.5l4.2-5 3.6 3 5.2-7" />
    <circle cx="18.5" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);
export const IconCube = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z" />
    <path d="M4 7.2l8 4.4 8-4.4M12 11.6v9.6" />
  </svg>
);
export const IconGrid = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
  </svg>
);
export const IconSliders = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M6 3.5v17M12 3.5v17M18 3.5v17" />
    <rect x="3.8" y="13" width="4.4" height="3.2" rx="1" fill="var(--bg)" />
    <rect x="9.8" y="6.5" width="4.4" height="3.2" rx="1" fill="var(--bg)" />
    <rect x="15.8" y="11" width="4.4" height="3.2" rx="1" fill="var(--bg)" />
  </svg>
);
export const IconImport = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5" />
    <path d="M4 15.5v2.5a2 2 0 002 2h12a2 2 0 002-2v-2.5" />
  </svg>
);
export const IconExport = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M12 14.5v-11M7.5 8L12 3.5 16.5 8" />
    <path d="M4 15.5v2.5a2 2 0 002 2h12a2 2 0 002-2v-2.5" />
  </svg>
);
export const IconChevronDown = ({ size = 14, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M6 9.5l6 6 6-6" />
  </svg>
);
export const IconChevronLeft = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M15 5.5L8.5 12l6.5 6.5" />
  </svg>
);
export const IconChevronRight = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M9 5.5l6.5 6.5L9 18.5" />
  </svg>
);
export const IconClose = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconPlus = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconTrash = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l.9 12.2a2 2 0 002 1.8h5.2a2 2 0 002-1.8l.9-12.2" />
  </svg>
);
export const IconComment = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M4.5 5.5h15v10h-8l-4.5 3.5v-3.5H4.5z" />
  </svg>
);
export const IconExpand = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />
  </svg>
);
export const IconSearch = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l5 5" />
  </svg>
);
export const IconCopy = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6.5a2 2 0 00-2-2h-7a2 2 0 00-2 2v7a2 2 0 002 2h2" />
  </svg>
);
export const IconPlay = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M7.5 5.5v13l11-6.5z" fill="currentColor" />
  </svg>
);
export const IconPause = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 5.5v13M16 5.5v13" strokeWidth="2.6" />
  </svg>
);
export const IconRefresh = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M19.5 12a7.5 7.5 0 11-2.2-5.3M19.5 4.5v4h-4" />
  </svg>
);
export const IconCheck = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
export const IconShield = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M12 3l7.5 3v6c0 4.2-3.2 7.6-7.5 9-4.3-1.4-7.5-4.8-7.5-9V6z" />
    <path d="M8.8 12.2l2.2 2.2 4.3-4.6" />
  </svg>
);
