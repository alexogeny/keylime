import type { Shoe } from "../types.js";

export const UNDER_ARMOUR: Shoe[] = [
  // ── RACE ─────────────────────────────────────────────────────────────────────

  {
    id: "ua-velociti-elite",
    brand: "Under Armour",
    model: "Velociti Elite",
    category: "neutral",
    cushion: "high",
    variants: [
      {
        version: "2",
        year: 2024,
        spec: { heelStack: 37, forefootStack: 29, drop: 8, weightGrams: 230, msrp: 200 },
        foam: "HOVR (beaded foam)",
        plate: { present: true, material: "carbon", description: "full-length carbon plate" },
        surfaces: ["road"],
        rocker: true,
        features: ["HOVR beaded foam", "carbon plate", "8mm drop", "race shoe"],
        useCases: ["race", "tempo"],
        notes: "Predecessor to Elite 3. Established UA as a credible super-shoe contender.",
      },
      {
        version: "3",
        year: 2025,
        spec: { heelStack: 37.5, forefootStack: 35.5, drop: 2, weightGrams: 221, msrp: 225, refSize: "unisex M9/W10.5" },
        genderVariants: {
          // Unisex sizing — same shoe, same weight across genders
          mens:   { refSize: "unisex M9" },
          womens: { refSize: "unisex W10.5 (same as M9)" },
        },
        foam: "HOVR+ (beaded/cellular foam, firmer than PEBA)",
        plate: { present: true, material: "carbon", description: "full-length carbon plate" },
        surfaces: ["road"],
        rocker: true,
        features: [
          "ultra-low 2mm drop — lowest of any major super-shoe",
          "HOVR+ beaded foam (firmer and more responsive than PEBA)",
          "unisex sizing",
          "Elite elite runner endorsements in major marathons",
        ],
        useCases: ["race", "tempo"],
        notes:
          "Used in elite-level marathon competition. Unique 2mm drop is the lowest in the super-shoe market — excellent for midfoot strikers and high-cadence runners. Firmer than PEBA-based competitors. RTINGS top-rated for midfoot strikers.",
      },
    ],
  },

  // ── DAILY TRAINERS ───────────────────────────────────────────────────────────

  {
    id: "ua-hovr-machina",
    brand: "Under Armour",
    model: "HOVR Machina",
    category: "neutral",
    cushion: "moderate",
    variants: [
      {
        version: "3",
        year: 2023,
        spec: { heelStack: 34, forefootStack: 26, drop: 8, weightGrams: 292, msrp: 140 },
        foam: "HOVR + Micro G (dual foam)",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["HOVR + Micro G dual foam", "8mm drop", "MapMyRun sensor integration", "moderate cushion"],
        useCases: ["daily-trainer", "tempo"],
        notes: "UA's versatile daily trainer. HOVR foam delivers energy return; Micro G provides firm base. Built-in MapMyRun sensor tracks cadence and stride length. Reliable but not as modern as competitors.",
      },
    ],
  },

  {
    id: "ua-hovr-infinite",
    brand: "Under Armour",
    model: "HOVR Infinite",
    category: "neutral",
    cushion: "high",
    variants: [
      {
        version: "5",
        year: 2024,
        spec: { heelStack: 36, forefootStack: 28, drop: 8, weightGrams: 298, msrp: 140 },
        foam: "HOVR (beaded foam)",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["HOVR beaded foam", "8mm drop", "high cushion daily trainer", "MapMyRun integration"],
        useCases: ["daily-trainer", "long-run", "recovery"],
        notes: "UA's max-cushion daily trainer. HOVR foam is UA's most premium cushioning. More plush than the Machina. Good for easy days and recovery runs.",
      },
    ],
  },
];
