import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import { auth, db, firebaseConfigured } from "./firebase";
import { COMPANY_ID, type Company, type Employee } from "./types";
import { resolveProfilePhoto } from "./profile-photo";

interface AuthState {
  user: User | null;
  isAdmin: boolean;
  employee: Employee | null;
  company: Company | null;
  loading: boolean;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);

  async function hydrate(u: User) {
    const userEmail = u.email ? u.email.toLowerCase().trim() : "";
    const authPhotoUrl = resolveProfilePhoto(u);
    const ADMIN_EMAILS = [
      "pabibek9@gmail.com",
      "bibekparajuli05@gmail.com",
      "louis@ironbrij.com.au",
    ];
    const isEmailAdmin = Boolean(userEmail && ADMIN_EMAILS.includes(userEmail));

    // Auto-save user to users collection in Firestore
    setDoc(
      doc(db(), "users", u.uid),
      {
        uid: u.uid,
        name: u.displayName || (userEmail ? userEmail.split("@")[0] : "User"),
        email: userEmail,
        ...(authPhotoUrl ? { photoUrl: authPhotoUrl } : {}),
        lastLogin: new Date().toISOString(),
      },
      { merge: true },
    ).catch(() => {});

    try {
      // Parallelize Firestore queries for maximum speed
      const [adminResult, empResult] = await Promise.allSettled([
        getDoc(doc(db(), "admins", u.uid)),
        getDoc(doc(db(), "employees", u.uid)),
      ]);

      const adminSnap = adminResult.status === "fulfilled" ? adminResult.value : null;
      const adminStatus = (adminSnap && adminSnap.exists()) || isEmailAdmin;
      setIsAdmin(adminStatus);

      if (adminStatus && (!adminSnap || !adminSnap.exists())) {
        setDoc(
          doc(db(), "admins", u.uid),
          { role: "owner", email: userEmail, createdAt: new Date().toISOString() },
          { merge: true },
        ).catch(() => {});
      }

      const empSnap = empResult.status === "fulfilled" ? empResult.value : null;
      if (empSnap && empSnap.exists()) {
        const empData = empSnap.data() as Omit<Employee, "id">;
        const employeeUpdates: Partial<Employee> = {};
        if (userEmail && empData.email?.toLowerCase() !== userEmail) {
          employeeUpdates.email = userEmail;
        }
        if (authPhotoUrl && empData.photoUrl !== authPhotoUrl) {
          employeeUpdates.photoUrl = authPhotoUrl;
        }
        if (Object.keys(employeeUpdates).length) {
          Object.assign(empData, employeeUpdates);
          setDoc(doc(db(), "employees", u.uid), employeeUpdates, { merge: true }).catch(() => {});
        }
        setEmployee({ id: empSnap.id, ...empData });
      } else if (userEmail) {
        const q = query(collection(db(), "employees"), where("email", "==", userEmail));
        const querySnap = await getDocs(q);
        if (!querySnap.empty) {
          const matchDoc = querySnap.docs[0];
          const empData = matchDoc.data();
          const updatedEmp = {
            ...empData,
            email: userEmail,
            authUid: u.uid,
            photoUrl: authPhotoUrl || resolveProfilePhoto(empData as Omit<Employee, "id">) || "",
          };
          setDoc(doc(db(), "employees", u.uid), updatedEmp, { merge: true }).catch(() => {});
          setEmployee({ id: u.uid, ...(updatedEmp as Omit<Employee, "id">) });
        } else if (adminStatus) {
          // Auto-create employee record for admin if none exists
          const adminEmpDoc: Employee = {
            id: u.uid,
            authUid: u.uid,
            name: u.displayName || (userEmail ? userEmail.split("@")[0] : "Admin"),
            email: userEmail,
            reportingRequirement: "sod_eod",
            status: "active",
            inviteStatus: "accepted",
            timezone: "Asia/Kathmandu",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } as Employee;
          setDoc(doc(db(), "employees", u.uid), adminEmpDoc, { merge: true }).catch(() => {});
          setEmployee(adminEmpDoc);
        } else {
          setEmployee(null);
        }
      } else if (adminStatus) {
        const adminEmpDoc: Employee = {
          id: u.uid,
          authUid: u.uid,
          name: u.displayName || "Admin",
          email: userEmail,
          reportingRequirement: "sod_eod",
          status: "active",
          inviteStatus: "accepted",
          timezone: "Asia/Kathmandu",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as Employee;
        setDoc(doc(db(), "employees", u.uid), adminEmpDoc, { merge: true }).catch(() => {});
        setEmployee(adminEmpDoc);
      } else {
        setEmployee(null);
      }
    } catch (err) {
      console.error("Hydration error:", err);
      setIsAdmin(isEmailAdmin);
    }
  }

  useEffect(() => {
    if (!firebaseConfigured) {
      setLoading(false);
      return;
    }
    const unsubComp = onSnapshot(doc(db(), "companies", COMPANY_ID), (s) => {
      if (s.exists()) setCompany({ ...(s.data() as Company) });
    });

    const unsub = onAuthStateChanged(auth(), (u) => {
      setUser(u);
      if (u) {
        const userEmail = u.email ? u.email.toLowerCase().trim() : "";
        const ADMIN_EMAILS = [
          "pabibek9@gmail.com",
          "bibekparajuli05@gmail.com",
          "louis@ironbrij.com.au",
        ];
        const isEmailAdmin = Boolean(userEmail && ADMIN_EMAILS.includes(userEmail));
        setIsAdmin(isEmailAdmin);
        setLoading(false); // Unblock UI immediately (0ms wait)
        hydrate(u).catch(() => {});
      } else {
        setIsAdmin(false);
        setEmployee(null);
        setLoading(false);
      }
    });
    return () => {
      unsub();
      unsubComp();
    };
  }, []);

  const value: AuthState = {
    user,
    isAdmin,
    employee,
    company,
    loading,
    logout: async () => {
      if (firebaseConfigured) await signOut(auth());
    },
    refresh: async () => {
      if (user) await hydrate(user);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
