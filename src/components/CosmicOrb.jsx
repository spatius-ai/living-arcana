export default function CosmicOrb({ size = 50, palette = {}, background = "#05050f", style, className }) {
  const { anchor = "#6a3cff", colorA = "#3ce0ff", colorB = "#a24bff" } = palette;
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        display: "block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: `radial-gradient(circle at 35% 28%, ${colorA}, transparent 38%), radial-gradient(circle at 70% 65%, ${colorB}, transparent 55%), radial-gradient(circle, ${anchor}, ${background} 75%)`,
        boxShadow: `inset -6px -8px 12px ${background}, inset 2px 2px 6px #ffffff66`,
        ...style,
      }}
    />
  );
}
