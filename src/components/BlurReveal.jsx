import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import "./BlurReveal.css";

export function BlurReveal({
  children,
  className = "",
  delay = 0,
  speedReveal = 1.5,
  speedSegment = 0.5,
  trigger = true,
  onAnimationComplete,
  onAnimationStart,
  as: Tag = "p",
  style,
  inView = false,
  once = true,
  letterSpacing,
  blur = 12,
  yOffset = 10,
  stagger: staggerOverride,
  duration: durationOverride,
  ...elementProps
}) {
  const rootRef = useRef(null);
  const [isVisible, setIsVisible] = useState(() => trigger && !inView);
  const lines = useMemo(() => children.split("\n").map((line) => line.split(" ")), [children]);
  const stagger = staggerOverride ?? 0.03 / Math.max(speedReveal, 0.01);
  const duration = durationOverride ?? 0.3 / Math.max(speedSegment, 0.01);

  useEffect(() => {
    if (!trigger) {
      setIsVisible(false);
      return undefined;
    }

    if (!inView) {
      setIsVisible(true);
      return undefined;
    }

    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return undefined;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setIsVisible(true);
        if (once) observer.disconnect();
      } else if (!once) {
        setIsVisible(false);
      }
    }, { threshold: 0.2 });

    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, once, trigger]);

  useEffect(() => {
    if (!trigger || !isVisible) return undefined;

    onAnimationStart?.();

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const characterCount = Array.from(children).length;
    const totalSeconds = reducedMotion
      ? 0
      : delay + Math.max(characterCount - 1, 0) * stagger + duration;
    const timer = window.setTimeout(() => onAnimationComplete?.(), totalSeconds * 1000);

    return () => window.clearTimeout(timer);
  }, [children, delay, duration, isVisible, onAnimationComplete, onAnimationStart, stagger, trigger]);

  if (!trigger) return null;

  let characterIndex = 0;
  let wordSequence = 0;

  return (
    <Tag
      {...elementProps}
      ref={rootRef}
      className={`blur-reveal${isVisible ? " is-visible" : ""}${className ? ` ${className}` : ""}`}
      style={{
        ...style,
        "--blur-reveal-delay": `${delay}s`,
        "--blur-reveal-duration": `${duration}s`,
        "--blur-reveal-stagger": `${stagger}s`,
        "--blur-reveal-blur": `${blur}px`,
        "--blur-reveal-y": `${yOffset}px`,
      }}
    >
      <span className="blur-reveal__sr-only">{children}</span>
      {lines.map((words, lineIndex) => (
        <Fragment key={`line-${lineIndex}`}>
          {lineIndex > 0 ? <br aria-hidden="true" /> : null}
          {words.map((word, wordIndex) => {
            const characters = Array.from(word);
            const currentWordIndex = wordSequence;
            wordSequence += 1;

            return (
              <span
                key={`word-${lineIndex}-${wordIndex}`}
                className="blur-reveal__word"
                data-word-index={currentWordIndex}
                aria-hidden="true"
              >
                {characters.map((character, index) => {
                  const currentIndex = characterIndex;
                  characterIndex += 1;

                  return (
                    <span
                      key={`character-${lineIndex}-${wordIndex}-${index}`}
                      className="blur-reveal__character"
                      style={{
                        "--blur-reveal-index": currentIndex,
                        ...(letterSpacing ? { marginRight: letterSpacing } : {}),
                      }}
                    >
                      {character}
                    </span>
                  );
                })}
                {wordIndex < words.length - 1 && (() => {
                  const currentIndex = characterIndex;
                  characterIndex += 1;

                  return (
                    <span
                      className="blur-reveal__character blur-reveal__space"
                      style={{ "--blur-reveal-index": currentIndex }}
                    >
                      &nbsp;
                    </span>
                  );
                })()}
              </span>
            );
          })}
        </Fragment>
      ))}
    </Tag>
  );
}

export default BlurReveal;
