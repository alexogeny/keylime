import type { Shoe } from "../types.js";

export const SALOMON: Shoe[] = [
  // ── ROAD ─────────────────────────────────────────────────────────────────────

  {
    id: "salomon-aero-glide",
    brand: "Salomon",
    model: "Aero Glide",
    category: "neutral",
    cushion: "max",
    variants: [
      {
        version: "2",
        year: 2024,
        spec: { heelStack: 38, forefootStack: 30, drop: 8, weightGrams: 255, msrp: 150 },
        foam: "Energy Foam (EVA blend)",
        plate: { present: false },
        surfaces: ["road"],
        rocker: true,
        features: ["road daily trainer", "8mm drop", "rocker geometry"],
        useCases: ["daily-trainer", "long-run"],
        notes: "Predecessor to Aero Glide 3. Established Salomon as a credible road running brand.",
      },
      {
        version: "3",
        year: 2025,
        spec: { heelStack: 40, forefootStack: 32, drop: 8, weightGrams: 248, msrp: 160, refSize: "men's US 9" },
        genderVariants: {
          mens:   { weightGrams: 248, refSize: "men's US 9" },
          womens: { weightGrams: 220, refSize: "women's US 8" },
        },
        foam: "Energy Foam EVO (eTPU — next-gen, outperforms PEBA in energy return per Road Trail Run)",
        plate: { present: false },
        surfaces: ["road"],
        rocker: true,
        features: [
          "eTPU Energy Foam EVO — 'outperforms PEBA-type foams' (Road Trail Run)",
          "no-internal-stitching upper",
          "40mm/32mm max stack, plateless",
          "stable wide platform",
        ],
        useCases: ["daily-trainer", "long-run", "tempo"],
        notes:
          "Road Trail Run: 'A Modern, Light and Energetic Daily Trainer'. eTPU Energy Foam EVO is cutting-edge — Road Trail Run says these new foams 'even the former state of the art PEBA foams pale in comparison to'. Light at 248g for a max-stack shoe. Strong plateless super trainer alternative.",
      },
    ],
  },

  {
    id: "salomon-aero-blaze",
    brand: "Salomon",
    model: "Aero Blaze",
    category: "neutral",
    cushion: "high",
    variants: [
      {
        version: "2",
        year: 2025,
        spec: { heelStack: 37, forefootStack: 29, drop: 8, weightGrams: 235, msrp: 150 },
        foam: "Energy Foam EVO (eTPU)",
        plate: { present: false },
        surfaces: ["road"],
        rocker: true,
        features: ["same eTPU Energy Foam EVO as Aero Glide 3", "slightly lower stack than Aero Glide", "lighter", "8mm drop"],
        useCases: ["daily-trainer", "tempo", "long-run"],
        notes: "Lighter companion to the Aero Glide 3. Same eTPU foam but slightly less stack — a bit more responsive. Good if you find the Aero Glide 3 too cushioned.",
      },
    ],
  },

  // ── TRAIL ─────────────────────────────────────────────────────────────────────

  {
    id: "salomon-sense-ride",
    brand: "Salomon",
    model: "Sense Ride",
    category: "neutral",
    cushion: "moderate",
    variants: [
      {
        version: "5",
        year: 2023,
        spec: { heelStack: 30, forefootStack: 22, drop: 8, weightGrams: 315, msrp: 140, refSize: "men's US 9" },
        genderVariants: {
          mens:   { weightGrams: 315, refSize: "men's US 9" },
          womens: { weightGrams: 275, refSize: "women's US 8" },
        },
        foam: "EnergyCell+ EVA",
        plate: { present: false },
        surfaces: ["trail"],
        rocker: false,
        features: ["Contagrip MA outsole", "8mm drop", "cushioned trail trainer", "protective toe bumper"],
        useCases: ["trail"],
        notes:
          "RunRepeat 'Best for Gravel Salomon 2026'. Trail and Kale: 'Best Affordable Men's Trail Shoe / Best Women's Trail Shoe for Narrow Feet'. Versatile trail trainer, works well on gravel, hardpack, and light technical terrain. 8mm drop.",
      },
    ],
  },

  {
    id: "salomon-speedcross",
    brand: "Salomon",
    model: "Speedcross",
    category: "neutral",
    cushion: "moderate",
    variants: [
      {
        version: "6",
        year: 2023,
        spec: { heelStack: 28, forefootStack: 22, drop: 6, weightGrams: 320, msrp: 140 },
        foam: "EnergyCell EVA",
        plate: { present: false },
        surfaces: ["trail"],
        rocker: false,
        features: ["aggressive Contagrip outsole (deep chevron lugs)", "6mm drop", "lug pattern optimised for mud/soft terrain", "quicklace system"],
        useCases: ["trail"],
        notes:
          "RunRepeat 'Best Grip Salomon 2026'. Most aggressive lug pattern in the Salomon lineup. Designed for soft, muddy, technical terrain. The aggressive lugs are less comfortable on hard-packed trails or roads. Iconic trail shoe.",
      },
    ],
  },

  {
    id: "salomon-ultra-glide",
    brand: "Salomon",
    model: "Ultra Glide",
    category: "neutral",
    cushion: "high",
    variants: [
      {
        version: "2",
        year: 2023,
        spec: { heelStack: 33, forefootStack: 25, drop: 8, weightGrams: 285, msrp: 155 },
        foam: "EnergyCell+ EVA",
        plate: { present: false },
        surfaces: ["trail"],
        rocker: true,
        features: ["rocker geometry for efficiency", "8mm drop", "high cushion for ultra distances", "Contagrip outsole"],
        useCases: ["trail"],
        notes:
          "RunRepeat 'Best for Ultra Salomon 2026'. Designed for high-mileage trail days and ultramarathon distances. Rocker geometry reduces fatigue on long efforts. More cushioned than Sense Ride 5.",
      },
    ],
  },

  {
    id: "salomon-pulsar-trail",
    brand: "Salomon",
    model: "Pulsar Trail",
    category: "neutral",
    cushion: "moderate",
    variants: [
      {
        version: "2",
        year: 2024,
        spec: { heelStack: 30, forefootStack: 24, drop: 6, weightGrams: 265, msrp: 145 },
        foam: "Energy Foam (EVA blend)",
        plate: { present: false },
        surfaces: ["trail"],
        rocker: false,
        features: ["6mm drop", "versatile trail/gravel", "Contagrip outsole", "protective"],
        useCases: ["trail"],
        notes: "RunRepeat 'Best Daily Trainer Trail Salomon 2026'. Versatile trail daily trainer. Lighter than Sense Ride 5 with slightly less cushion. Good for well-maintained trails and gravel.",
      },
    ],
  },

  {
    id: "salomon-genesis",
    brand: "Salomon",
    model: "Genesis",
    category: "neutral",
    cushion: "high",
    variants: [
      {
        version: "1",
        year: 2025,
        spec: { heelStack: 36, forefootStack: 28, drop: 8, weightGrams: 290, msrp: 165 },
        foam: "EnergyCell Pro (TPEE-based)",
        plate: { present: false },
        surfaces: ["trail"],
        rocker: true,
        features: ["TPEE EnergyCell Pro foam", "8mm drop", "rocker geometry", "versatile technical trail"],
        useCases: ["trail"],
        notes: "RunRepeat 'Best Overall Salomon Trail 2026'. New TPEE-based EnergyCell Pro delivers superior energy return on trails. High cushion with rocker for efficient forward motion.",
      },
    ],
  },

  {
    id: "salomon-slab-genesis",
    brand: "Salomon",
    model: "S/Lab Genesis",
    category: "neutral",
    cushion: "moderate",
    variants: [
      {
        version: "1",
        year: 2025,
        spec: { heelStack: 32, forefootStack: 26, drop: 6, weightGrams: 235, msrp: 220 },
        foam: "EnergyCell Pro (TPEE)",
        plate: { present: false },
        surfaces: ["trail"],
        rocker: false,
        features: ["lightweight S/Lab construction", "TPEE EnergyCell Pro", "6mm drop", "race-focused"],
        useCases: ["trail", "race"],
        notes: "RunRepeat 'Best Lightweight Salomon Trail 2026'. Premium race-oriented version of the Genesis. 55g lighter than standard Genesis. Built for fast trail racing.",
      },
    ],
  },

  {
    id: "salomon-xa-pro-3d",
    brand: "Salomon",
    model: "XA Pro 3D",
    category: "stability",
    cushion: "moderate",
    variants: [
      {
        version: "v9 GTX",
        year: 2024,
        spec: { heelStack: 27, forefootStack: 19, drop: 8, weightGrams: 335, msrp: 155 },
        foam: "EnergyCell EVA",
        plate: { present: false },
        surfaces: ["trail"],
        rocker: false,
        features: ["Gore-Tex waterproof", "Sensifit upper", "3D chassis for stability", "8mm drop", "protective"],
        useCases: ["trail"],
        notes:
          "RunRepeat 'Best Stability Salomon Trail 2026'. Gore-Tex waterproof and 3D chassis make it a fortress for technical, wet, or unpredictable terrain. Heavier than other Salomon trail shoes but unmatched protection.",
      },
    ],
  },
];
