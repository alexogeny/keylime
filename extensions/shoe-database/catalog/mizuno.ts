import type { Shoe } from "../types.js";

export const MIZUNO: Shoe[] = [
  {
    id: "mizuno-wave-rider",
    brand: "Mizuno",
    model: "Wave Rider",
    category: "neutral",
    cushion: "moderate",
    variants: [
      {
        version: "27",
        year: 2024,
        spec: { heelStack: 33, forefootStack: 21, drop: 12, weightGrams: 265, msrp: 140 },
        foam: "ENERZY CORE + ENERZY",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["Fan Wave plate (structural guidance)", "12mm drop", "ENERZY dual foam", "traditional trainer feel"],
        useCases: ["daily-trainer", "tempo", "long-run"],
        notes: "Mizuno's flagship neutral trainer. Fan Wave plate provides structural guidance without being a stability shoe. 12mm drop similar to Brooks Ghost. Firmer, more traditional feel.",
      },
    ],
  },

  {
    id: "mizuno-wave-inspire",
    brand: "Mizuno",
    model: "Wave Inspire",
    category: "stability",
    cushion: "moderate",
    variants: [
      {
        version: "20",
        year: 2024,
        spec: { heelStack: 33, forefootStack: 21, drop: 12, weightGrams: 280, msrp: 140 },
        foam: "ENERZY CORE + ENERZY",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["Fan Wave plate (asymmetric for stability)", "12mm drop", "smooth transition"],
        useCases: ["daily-trainer", "long-run"],
        notes: "Mizuno's stability trainer. Fan Wave provides medial stability through structural wave geometry, not foam post. 12mm drop. Unique approach vs foam-based stability.",
      },
    ],
  },

  {
    id: "mizuno-neo-zen",
    brand: "Mizuno",
    model: "Neo Zen",
    category: "neutral",
    cushion: "max",
    variants: [
      {
        version: "2",
        year: 2026,
        spec: { heelStack: 42, forefootStack: 32, drop: 10, weightGrams: 265, msrp: 170 },
        foam: "ENERZY NEO (supercritical)",
        plate: { present: false },
        surfaces: ["road"],
        rocker: true,
        features: ["ENERZY NEO supercritical foam", "high stack", "10mm drop", "RTINGS popular 2026"],
        useCases: ["daily-trainer", "long-run", "recovery"],
        notes: "RTINGS listed as popular 2026 Mizuno. Neo Zen represents Mizuno's entry into the high-stack supercritical foam category. ENERZY NEO is their premium foam.",
      },
    ],
  },

  {
    id: "mizuno-wave-horizon",
    brand: "Mizuno",
    model: "Wave Horizon",
    category: "stability",
    cushion: "max",
    variants: [
      {
        version: "7",
        year: 2024,
        spec: { heelStack: 35, forefootStack: 23, drop: 12, weightGrams: 305, msrp: 160 },
        foam: "ENERZY + ENERZY LITE",
        plate: { present: false },
        surfaces: ["road"],
        rocker: false,
        features: ["dual-density Fan Wave", "12mm drop", "max cushion + stability", "wide base"],
        useCases: ["daily-trainer", "long-run", "walking"],
        notes: "Mizuno's max-cushion stability option. Dual-density Wave plate provides maximum support. 12mm drop. For runners who want Mizuno's structural stability with more cushion than Wave Inspire.",
      },
    ],
  },

  {
    id: "mizuno-wave-rebellion",
    brand: "Mizuno",
    model: "Wave Rebellion",
    category: "neutral",
    cushion: "moderate",
    variants: [
      {
        version: "Pro 2",
        year: 2025,
        spec: { heelStack: 40, forefootStack: 32, drop: 8, weightGrams: 215, msrp: 200 },
        foam: "ENERZY CORE + ENERZY LITE",
        plate: { present: true, material: "nylon", description: "ENERZY PROPULSION PLATE nylon" },
        surfaces: ["road"],
        rocker: true,
        features: ["ENERZY PROPULSION PLATE (nylon)", "dual foam layers", "8mm drop", "marathon training"],
        useCases: ["tempo", "race", "long-run"],
        notes: "Mizuno's performance racer/trainer. Nylon ENERZY PROPULSION PLATE delivers speed without full carbon cost. Competes with Saucony Endorphin Speed. 8mm drop.",
      },
    ],
  },
];
