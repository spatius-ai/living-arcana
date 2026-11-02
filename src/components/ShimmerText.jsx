import "./ShimmerText.css";

export default function ShimmerText({ children = "Considering…", className = "" }) {
  return (
    <span className={`shimmer-text${className ? ` ${className}` : ""}`}>
      {children}
    </span>
  );
}
