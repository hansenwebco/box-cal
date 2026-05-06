import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-app.js";
import { 
    getFirestore, doc, getDoc, setDoc, onSnapshot, deleteDoc,
    collection, query, orderBy, limit, getDocs 
} from "https://www.gstatic.com/firebasejs/10.11.1/firebase-firestore.js";
import { 
    getAuth, 
    GoogleAuthProvider, 
    signInWithPopup, 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    onAuthStateChanged, 
    signOut 
} from "https://www.gstatic.com/firebasejs/10.11.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyB0t9GZc0BziTXPJIdTQ8zmGs-2VsovcQU",
  authDomain: "box-cal.firebaseapp.com",
  projectId: "box-cal",
  storageBucket: "box-cal.firebasestorage.app",
  messagingSenderId: "882369610202",
  appId: "1:882369610202:web:9fc0f1cb88f52a4d4600e3",
  measurementId: "G-NVYDG7HLGB"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Providers
const providers = {
    google: new GoogleAuthProvider()
};

export { 
    db, auth, providers, 
    signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword,
    onAuthStateChanged, signOut, 
    doc, getDoc, setDoc, onSnapshot, deleteDoc,
    collection, query, orderBy, limit, getDocs
};
