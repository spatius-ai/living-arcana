import { forwardRef } from "react";

function classes(base, className) {
  return `${base}${className ? ` ${className}` : ""}`;
}

export const ReadingComposer = forwardRef(function ReadingComposer(
  { className = "", ...props },
  ref,
) {
  return <section ref={ref} className={classes("three-card-followup", className)} {...props} />;
});

export const ReadingComposerHeader = forwardRef(function ReadingComposerHeader(
  { className = "", ...props },
  ref,
) {
  return <div ref={ref} className={classes("three-card-followup-heading", className)} {...props} />;
});

export const ReadingComposerSpeaker = forwardRef(function ReadingComposerSpeaker(
  { className = "", ...props },
  ref,
) {
  return <b ref={ref} className={classes("three-card-selected-speaker", className)} {...props} />;
});

export const ReadingComposerActions = forwardRef(function ReadingComposerActions(
  { className = "", ...props },
  ref,
) {
  return <span ref={ref} className={classes("three-card-followup-actions", className)} {...props} />;
});

export const ReadingComposerForm = forwardRef(function ReadingComposerForm(
  { className = "", ...props },
  ref,
) {
  return <form ref={ref} className={classes("qa-form three-card-followup-form", className)} {...props} />;
});

export const ReadingComposerField = forwardRef(function ReadingComposerField(
  { className = "", ...props },
  ref,
) {
  return <label ref={ref} className={classes("three-card-composer-field", className)} {...props} />;
});

export const ReadingComposerVoice = forwardRef(function ReadingComposerVoice(
  { className = "", type = "button", ...props },
  ref,
) {
  return <button ref={ref} className={classes("qa-submit three-card-voice-control", className)} type={type} {...props} />;
});

export const ReadingComposerSend = forwardRef(function ReadingComposerSend(
  { className = "", type = "submit", ...props },
  ref,
) {
  return <button ref={ref} className={classes("qa-submit three-card-send-control", className)} type={type} {...props} />;
});
