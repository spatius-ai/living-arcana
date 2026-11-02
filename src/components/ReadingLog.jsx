import { createContext, forwardRef, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import "./ReadingLog.css";

const ReadingLogContext = createContext(null);

const icons = {
  log: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="5" y="3.5" width="14" height="17" rx="2.5" />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4.5" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  ),
};

function useReadingLog() {
  const value = useContext(ReadingLogContext);
  if (!value) throw new Error("ReadingLog parts must be rendered inside ReadingLog.");
  return value;
}

function assignRef(ref, value) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export function ReadingLog({ open, onOpenChange, children }) {
  const triggerRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  const close = useCallback(() => {
    onOpenChange(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, [onOpenChange]);

  // A fresh object here re-rendered every context consumer whenever the owner
  // re-rendered (e.g. per revealed chunk of a streamed answer).
  const value = useMemo(
    () => ({ close, closeRef, open, onOpenChange, triggerRef }),
    [close, onOpenChange, open],
  );

  return (
    <ReadingLogContext.Provider value={value}>
      {children}
    </ReadingLogContext.Provider>
  );
}

export const ReadingLogTrigger = forwardRef(function ReadingLogTrigger(
  { children, className = "", type = "button", ...props },
  forwardedRef,
) {
  const { open, onOpenChange, triggerRef } = useReadingLog();
  return (
    <button
      ref={(node) => {
        triggerRef.current = node;
        assignRef(forwardedRef, node);
      }}
      className={`reading-log-trigger${className ? ` ${className}` : ""}`}
      type={type}
      aria-expanded={open}
      onClick={() => onOpenChange(true)}
      {...props}
    >
      {children || <>{icons.log}<span>Log</span></>}
    </button>
  );
});

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Keeps Tab / Shift+Tab cycling inside the open dialog, matching aria-modal
// (Escape and focus restore are handled by ReadingLog itself).
function trapFocus(event) {
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll(FOCUSABLE)]
    .filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const current = document.activeElement;
  if (event.shiftKey && (current === first || !event.currentTarget.contains(current))) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && current === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

export const ReadingLogContent = forwardRef(function ReadingLogContent(
  { children, className = "", eyebrow = "Reading log", id, onClick, onClickCapture, title, ...props },
  forwardedRef,
) {
  const { close, closeRef, open } = useReadingLog();
  if (!open) return null;
  const titleId = `${id}-title`;
  return (
    <section
      ref={forwardedRef}
      id={id}
      className={`reading-log-dialog${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={trapFocus}
      onClickCapture={onClickCapture}
      onClick={(event) => {
        // The Today reading surface treats a click outside its content as an
        // exit gesture. Keep dialog clicks inside this interaction boundary,
        // especially the close click that unmounts the dialog mid-bubble.
        event.stopPropagation();
        onClick?.(event);
      }}
      {...props}
    >
      <header className="reading-log-header">
        <span>
          <small>{eyebrow}</small>
          <h2 id={titleId}>{title}</h2>
        </span>
        <button
          ref={closeRef}
          type="button"
          data-reading-log-close=""
          aria-label="Close reading log"
          onClick={(event) => {
            event.stopPropagation();
            close();
          }}
        >
          {icons.close}
        </button>
      </header>
      <div className="reading-log-scroll" tabIndex={0}>{children}</div>
    </section>
  );
});

export function ReadingLogReading({ children, label }) {
  return (
    <article className="reading-log-reading">
      <span>{label}</span>
      {children}
    </article>
  );
}

export function ReadingLogTurn({ answer, answerLabel, pending = false, question, questionLabel = "You" }) {
  return (
    <article className="reading-log-turn">
      <p><span>{questionLabel}</span>{question}</p>
      <p className={pending ? "is-pending" : undefined}><span>{answerLabel}</span>{answer}</p>
    </article>
  );
}
