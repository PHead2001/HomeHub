# 🏠 HomeHub: All-in-One Home Management

HomeHub is a sophisticated, family-oriented web application designed to centralize and streamline household management. It combines task delegation, inventory tracking, pet care, maintenance records, and smart home control into a single, cohesive dashboard.

Built with a focus on ease of use and mobile accessibility, HomeHub leverages Generative AI to automate tedious tasks like categorizing groceries or summarizing maintenance logs.

---

## 🚀 Key Modules

### 📋 Chore Chart & Household Tasks
A robust system for managing recurring and one-time tasks.
- **Smart Scheduling**: Support for daily (including weekday-only), weekly, and monthly recurrence.
- **Room-Based Organization**: Group chores by room (Kitchen, Bathroom, Yard, etc.) with custom icons.
- **Sub-Tasks**: Break down complex chores into manageable steps.
- **Overdue Alerts**: Automatic checks at 12:01 AM every day to notify users of pending tasks.
- **Calendar View**: A visual overview of the entire household's schedule.
- **Reminders**: Personalized daily reminder times configurable per user.

### 🛒 Shopping Center & Pantry Inventory
Never lose track of what you need or what you have.
- **Multiple Lists**: Create specific lists for Groceries, Hardware, Auto, etc.
- **AI Categorization**: Uses Gemini AI to automatically sort added items into logical aisles (Produce, Dairy, etc.).
- **Barcode Scanning**: Built-in scanner to look up products via local library or the Open Food Facts API.
- **Inventory Integration**: Move items from your "Purchased" list directly into your Pantry/Fridge/Freezer inventory.
- **AI Recipe Generator**: A "Chef AI" that suggests creative recipes based solely on your current pantry items.

### 🐾 Pet Care Dashboard
A dedicated space for the furry members of the family.
- **Pet Profiles**: Track info, food schedules, and photos.
- **Detailed Logs**: Independent logs for Feeding (with amount/type tracking), Medication, and General Care (vet visits, grooming).
- **History Tracking**: Complete historical records of care activities.

### 🛠️ Home Maintenance Log
A permanent record of home health.
- **Log Management**: Track repairs and maintenance for appliances and structural items.
- **AI Summarization**: Long, technical notes can be summarized into concise bullet points using AI for quick review.

### 🤖 Smart Home Automation
Control your home directly from the hub.
- **Home Assistant Integration**: Securely connect to a local Home Assistant instance using Long-Lived Access Tokens.
- **Device Control**: View and manage the state of all your entities (lights, switches, sensors) from within the HomeHub UI.

---

## 🧠 AI Features (Powered by Google Genkit)

HomeHub integrates the **Gemini 2.0 Flash** model to provide intelligent assistance:
- **`categorizeGroceryItem`**: Intelligently assigns categories to food items based on household-specific lists.
- **`generateRecipe`**: Analyzes pantry inventory to provide coherent, delicious meal ideas.
- **`summarizeMaintenanceLog`**: Condenses complex maintenance notes.
- **`lookupBarcode`**: An agentic flow that checks a private household database before querying public APIs.

---

## 🛠️ Technical Stack

- **Framework**: [Next.js 15](https://nextjs.org/) (App Router)
- **Language**: TypeScript
- **Styling**: [Tailwind CSS](https://tailwindcss.com/) with [Shadcn UI](https://ui.shadcn.com/)
- **Backend/Database**: [Firebase](https://firebase.google.com/) (Firestore, Auth, Storage)
- **AI Toolkit**: [Genkit](https://github.com/firebase/genkit)
- **Real-time**: Firestore Snapshots for live updates across all devices.
- **Push Notifications**: Firebase Cloud Messaging (FCM) with a custom Service Worker API.

---

## 📂 Project Structure

```text
src/
├── ai/                # Genkit AI flows and configurations
├── app/               # Next.js App Router (Pages and API routes)
│   ├── api/sw/        # Dynamic Service Worker for Push Notifications
│   └── (modules)/     # Shopping, Pets, Chores, etc.
├── components/        # Reusable UI components
│   ├── ui/            # Shadcn base components
│   └── (features)/    # Feature-specific client components
├── contexts/          # Auth and Household state management
├── hooks/             # Custom React hooks (useAuth, useToast)
├── lib/               # Shared utilities, types, and Firebase config
└── functions/         # Firebase Cloud Functions (Node.js/TypeScript)
```

---

## ⚙️ Setup & Configuration

### Environment Variables
Create a `.env` file in the root with the following keys:
```env
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
NEXT_PUBLIC_FIREBASE_VAPID_KEY=...
GEMINI_API_KEY=...
```

### Firebase Functions
The push notification system requires the Cloud Function in `functions` to be deployed:
```bash
cd functions
npm install
npm run deploy
```

### Service Worker
The service worker is served via a Next.js API route (`/api/sw`) to allow environment variables to be injected into the worker at runtime, ensuring seamless FCM integration across different deployment environments.

---

## 🎨 Personalization
HomeHub supports high levels of customization:
- **Theming**: Users can choose custom HSL-based background and accent colors.
- **Household System**: A robust multi-user system using 6-digit invite codes to link family members together.
- **Avatar System**: Firebase Storage integration for user and pet profile pictures.

---

## 📝 License
This project is for private household management use. All rights reserved.
