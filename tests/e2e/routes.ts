export const authenticatedRoutes = [
  { path: "/", heading: "Welcome Home", content: "Your Dashboard" },
  { path: "/household", heading: "Manage Household", content: "The Foxy Residence E2E" },
  { path: "/chores", heading: "Chore Chart", content: "Reset the kitchen" },
  { path: "/shopping", heading: "Shopping Center", content: "Weekly Groceries" },
  { path: "/pets", heading: "Your Pets", content: "Maple" },
  { path: "/maintenance", heading: "Maintenance Center", content: "Main HVAC System" },
  { path: "/automation", heading: "House Automation", content: "Home Assistant Setup" },
  { path: "/notifications", heading: "Notification Center", content: "HVAC filter due today" },
  { path: "/profile", heading: "Your Profile", content: "Personal Information" },
  { path: "/library", heading: "Barcode Library", content: "E2E Oat Cereal" },
] as const;

export const snapshotName = (path: string) => (
  path === "/" ? "dashboard.png" : `${path.slice(1).replaceAll("/", "-")}.png`
);
