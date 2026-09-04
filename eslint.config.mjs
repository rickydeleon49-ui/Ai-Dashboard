// eslint-config-next v16 ships a flat config array directly — no FlatCompat needed.
import next from "eslint-config-next";

const config = [
  ...next,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "drizzle/**",
      "data/**",
      // Packaged desktop output — third-party and generated code.
      "release/**",
    ],
  },
];

export default config;
