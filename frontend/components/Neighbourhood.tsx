import styles from "./neighbourhood.module.css";

function Building({
  x,
  y,
  height,
  tone = "sand",
}: {
  x: number;
  y: number;
  height: number;
  tone?: "sand" | "green" | "rose";
}) {
  const colors = {
    sand: ["#e5d8b9", "#cabd9c", "#f3ead5"],
    green: ["#aebc9e", "#829c86", "#d3dac3"],
    rose: ["#cb997f", "#a97863", "#dfb69c"],
  }[tone];
  return (
    <g
      transform={`translate(${x} ${y})`}
      stroke="#4c5b46"
      strokeWidth="1.1"
      strokeLinejoin="round"
    >
      <path d={`M0 0 95 48V${height + 48}L0 ${height}Z`} fill={colors[0]} />
      <path
        d={`M95 48 150 20V${height + 20}L95 ${height + 48}Z`}
        fill={colors[1]}
      />
      <path d="M0 0 55-28 150 20 95 48Z" fill={colors[2]} />
      <path d="M10 0 55-23 140 20 95 43Z" fill="none" opacity=".4" />
      <g transform="matrix(1 .5 0 1 0 0)">
        {Array.from({ length: Math.floor((height - 20) / 32) }, (_, row) =>
          [17, 43, 69].map((col, index) => (
            <g key={`${row}-${col}`}>
              <rect
                className={row === index ? styles.window : undefined}
                x={col}
                y={19 + row * 32}
                width="12"
                height="19"
                fill={row === index ? "#e9c777" : "#65745c"}
                style={{ animationDelay: `${row + index}s` }}
              />
              <path d={`M${col - 2} ${39 + row * 32}h16`} />
            </g>
          )),
        )}
        <path d={`M39 ${height}v-26h19v26`} fill="#445947" />
      </g>
      <g transform="matrix(1 -.5 0 1 95 48)">
        {Array.from({ length: Math.floor((height - 20) / 32) }, (_, row) =>
          [12, 34].map((col) => (
            <rect
              key={`${row}-${col}`}
              x={col}
              y={19 + row * 32}
              width="9"
              height="19"
              fill="#4d6455"
            />
          )),
        )}
      </g>
      <path d="M24-7v-20l22 11V4Z" fill="#ced0b8" />
      <path d="M24-27 38-34 60-23 46-16Z" fill="#e2e1cb" />
      <path d="M46-16 60-23V-3L46 4Z" fill="#a8b09a" />
    </g>
  );
}

function Tree({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <ellipse cx="3" cy="3" rx="25" ry="10" fill="#314d39" opacity=".12" />
      <path d="M0 0v-42" stroke="#5a664c" strokeWidth="3" />
      <g className={styles.leaves}>
        <ellipse
          cx="0"
          cy="-43"
          rx="21"
          ry="30"
          fill="#819b77"
          stroke="#5a7253"
        />
        <path
          d="M0-16v-48M0-32l-10-10M0-42l11-12"
          fill="none"
          stroke="#5a7253"
        />
      </g>
    </g>
  );
}

export default function Neighbourhood({ className }: { className?: string }) {
  return (
    <svg
      className={`${styles.scene} ${className ?? ""}`}
      viewBox="0 0 680 570"
      fill="none"
      role="img"
      aria-label="An illustrated residential courtyard with warm windows, trees and neighbours"
    >
      <circle cx="345" cy="270" r="228" stroke="#8e9b7f" opacity=".22" />
      <circle
        cx="345"
        cy="270"
        r="250"
        stroke="#8e9b7f"
        opacity=".18"
        strokeDasharray="2 9"
      />
      <path
        d="M48 363 315 226 641 390 374 530Z"
        fill="#d9ddc8"
        stroke="#9da68c"
      />
      <path
        d="M48 363v9l326 168 267-141v-9L374 530Z"
        fill="#bbc4aa"
        stroke="#9da68c"
      />
      <path
        d="m80 364 236-121 293 148-235 124Z"
        stroke="#eff0e1"
        strokeWidth="11"
      />
      <path d="m208 370 90-46 174 88-92 47Z" fill="#ece5d3" stroke="#afb69d" />
      <path d="m219 376 80-42 160 81" stroke="#b1b9a0" strokeDasharray="3 5" />
      <Tree x={325} y={291} scale={0.8} />
      <Building x={320} y={113} height={150} tone="green" />
      <Building x={140} y={170} height={150} />
      <Tree x={122} y={363} scale={0.85} />
      <Tree x={540} y={379} />
      <Building x={421} y={284} height={94} tone="rose" />
      <path d="m295 403 52-27 65 33-52 27Z" fill="#a4b58c" stroke="#7e936e" />
      <Tree x={352} y={411} scale={0.88} />
      <Tree x={224} y={446} scale={1.08} />
      <path
        d="m279 450 31 16m-31-20 31 16m-27-16v12m23 0v12"
        stroke="#93715a"
        strokeWidth="4"
      />
      <g className={styles.neighbour}>
        <ellipse cx="284" cy="392" rx="7" ry="3" fill="#53634b" opacity=".2" />
        <circle cx="283" cy="372" r="3.5" fill="#805d44" />
        <path
          d="M283 378v8m-1 0-3 7m5-7 3 7"
          stroke="#b16a4b"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </g>
      <g className={styles.neighbourTwo}>
        <circle cx="394" cy="463" r="3.5" fill="#805d44" />
        <path
          d="M394 469v8m-1 0-3 7m5-7 3 7"
          stroke="#3c6657"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </g>
      <path
        d="m353 188 6 3 10-7"
        stroke="#f5f0df"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="m510 172 7-3 8 3m-47-31 5-2 6 2"
        stroke="#687d64"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
