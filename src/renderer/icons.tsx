// The icon set, in one place so the workspace chrome and the transfer panel
// draw from the same drawer rather than each carrying its own copy of a folder.
//
// One component with a name switch, rather than one component per icon: every
// icon shares the same stroke weight, join style and 24-unit box, and that
// shared frame is what makes them look like a set.

export function Icon({ name, className = '' }: { name: string; className?: string }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: `icon-svg ${className}`.trim(),
    'aria-hidden': true as const
  };

  switch (name) {
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'panel-left':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      );
    case 'panel-left-open':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16M6 9l2 3-2 3" />
        </svg>
      );
    case 'grid':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="7" height="7" rx="1" />
          <rect x="13" y="4" width="7" height="7" rx="1" />
          <rect x="4" y="13" width="7" height="7" rx="1" />
          <rect x="13" y="13" width="7" height="7" rx="1" />
        </svg>
      );
    case 'sessions':
      return (
        <svg {...common}>
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
      );
    case 'terminal':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 9l3 3-3 3M13 15h4" />
        </svg>
      );
    case 'ssh':
      return (
        <svg {...common}>
          <path d="M7 17l5-5-5-5M12 17h7" />
        </svg>
      );
    case 'history':
      return (
        <svg {...common}>
          <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5M4 4v4.5h4.5" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case 'spark':
      return (
        <svg {...common}>
          <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      );
    case 'sun':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      );
    case 'moon':
      return (
        <svg {...common}>
          <path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5z" />
        </svg>
      );
    case 'stack':
      return (
        <svg {...common}>
          <rect x="5" y="5" width="14" height="14" rx="1.5" />
        </svg>
      );
    case 'maximize':
      return (
        <svg {...common}>
          <path d="M8 4H4v4M16 4h4v4M4 16v4h4M20 16v4h-4" />
        </svg>
      );
    case 'restore':
      return (
        <svg {...common}>
          <path d="M8 8h12v12H8zM4 16V4h12" />
        </svg>
      );
    case 'chevron-left':
      return (
        <svg {...common}>
          <path d="M15 5l-7 7 7 7" />
        </svg>
      );
    case 'chevron-right':
      return (
        <svg {...common}>
          <path d="M9 5l7 7-7 7" />
        </svg>
      );
    case 'split-v':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="7" height="14" rx="1" />
          <rect x="13" y="5" width="7" height="14" rx="1" />
        </svg>
      );
    case 'split-h':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="7" rx="1" />
          <rect x="4" y="13" width="16" height="7" rx="1" />
        </svg>
      );
    case 'x':
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      );
    case 'mic':
      return (
        <svg {...common}>
          <rect x="9" y="2.5" width="6" height="12" rx="3" />
          <path d="M5 11.5a7 7 0 0 0 14 0" />
          <path d="M12 18.5V21" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="M5 13l4.5 4.5L19 7" />
        </svg>
      );
    case 'transfer':
      return (
        <svg {...common}>
          <path d="M8 20V6M8 6L4.5 9.5M8 6l3.5 3.5" />
          <path d="M16 4v14M16 18l3.5-3.5M16 18l-3.5-3.5" />
        </svg>
      );
    // Two ends and a line between them: a tunnel, rather than a plug, because a
    // forward is a route from somewhere to somewhere and both ends matter.
    case 'ports':
      return (
        <svg {...common}>
          <rect x="2.5" y="8.5" width="5" height="7" rx="1" />
          <rect x="16.5" y="8.5" width="5" height="7" rx="1" />
          <path d="M7.5 12h9M14 9.5l2.5 2.5L14 14.5" />
        </svg>
      );
    // The ports glyph with a plus, as folder-plus is to folder: one opens the
    // list, the other adds to it, and the rail shows both at once.
    case 'port-plus':
      return (
        <svg {...common}>
          <rect x="2.5" y="8.5" width="5" height="7" rx="1" />
          <path d="M7.5 12h7" />
          <path d="M18.5 8v8M14.5 12h8" />
        </svg>
      );
    case 'folder':
      return (
        <svg {...common}>
          <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z" />
        </svg>
      );
    case 'file':
      return (
        <svg {...common}>
          <path d="M6 3.5h7L18 8v12.5H6z" />
          <path d="M13 3.5V8h5" />
        </svg>
      );
    case 'link':
      return (
        <svg {...common}>
          <path d="M10 13a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7L11 6.3" />
          <path d="M14 11a4 4 0 0 0-5.7 0L6 13.3a4 4 0 0 0 5.7 5.7L13 17.7" />
        </svg>
      );
    case 'folder-plus':
      return (
        <svg {...common}>
          <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z" />
          <path d="M11 11v5M8.5 13.5h5" />
        </svg>
      );
    case 'trash':
      return (
        <svg {...common}>
          <path d="M4.5 7h15M9 7V4.5h6V7M6.5 7l1 13h9l1-13" />
        </svg>
      );
    case 'pencil':
      return (
        <svg {...common}>
          <path d="M4 20h4L20 8l-4-4L4 16z" />
        </svg>
      );
    case 'refresh':
      return (
        <svg {...common}>
          <path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5M20 4v4.5h-4.5" />
        </svg>
      );
    case 'arrow-up':
      return (
        <svg {...common}>
          <path d="M12 20V4M12 4l-6 6M12 4l6 6" />
        </svg>
      );
    case 'arrow-down':
      return (
        <svg {...common}>
          <path d="M12 4v16M12 20l-6-6M12 20l6-6" />
        </svg>
      );
    case 'level-up':
      return (
        <svg {...common}>
          <path d="M5 12l7-7 7 7" />
          <path d="M12 5v14" />
        </svg>
      );
    case 'help':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          {/* A question mark drawn with the same stroke as everything else,
              rather than set as text, so it scales with the icon box. */}
          <path d="M9.4 9a2.7 2.7 0 1 1 3.9 2.4c-.8.5-1.3 1-1.3 1.9v.4" />
          <path d="M12 17.2h.01" />
        </svg>
      );
    case 'info':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" />
          <path d="M12 8h.01" />
        </svg>
      );
    default:
      return <span className="icon" aria-hidden="true">•</span>;
  }
}
