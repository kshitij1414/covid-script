const open = require("open");
const path = require("path");
const player = require("node-wav-player");
const fs = require("fs");
const axios = require("axios");
const readline = require("readline");
const CryptoJS = require("crypto-js");
const cron = require("node-cron");
const notifier = require("node-notifier");
const firebase = require("firebase");
const { Auth } = require("./auth/auth")
require("firebase/firestore");
const PKG_TOP_DIR = "snapshot";

const runInPKG = (function () {
  const pathParsed = path.parse(__dirname);
  const root = pathParsed.root;
  const dir = pathParsed.dir;
  const firstDepth = path.relative(root, dir).split(path.sep)[0];
  return firstDepth === PKG_TOP_DIR;
})();

const baseHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36 Edg/90.0.818.66",
  origin: "https://selfregistration.cowin.gov.in",
  referer: "https://selfregistration.cowin.gov.in/",
};

let config = require("./config/conf.json");

if (runInPKG) {
  const deployPath = path.dirname(process.execPath);
  config = require(path.join(deployPath, "./config/conf.json"));
}

const basePath = `https://cdn-api.co-vin.in/api/v2`;
const registerOtpPath = `/auth/generateMobileOTP`;
const confirmOtpPath = `/auth/validateMobileOtp`;
const findByDistrictPath = `/appointment/sessions/public/findByDistrict`;
const appointmentSchedule = `/appointment/schedule`;
const getRecaptch = `/auth/getRecaptcha`;

var beneficiaries = ["20337198346770", "18548416475000"];
var txnId = "";
var token = "";
var captcha = "";
var lock = false;
var bookingDone = false;

const triggerRegistration = async (mobile) => {
  const key = "CoWIN@$#&*(!@%^&";
  const plainText = "b5cab167-7977-4df1-8027-a63aa144f04e";
  const payload = {
    mobile,
    secret: CryptoJS.AES.encrypt(plainText, key).toString(),
  };
  var headers = baseHeaders;
  try {
    var response = await axios.post(`${basePath}${registerOtpPath}`, payload, {
      headers,
    });
  } catch (e) {
    console.log(e);
  }
  txnId = response.data.txnId;
  return Promise.resolve(txnId);
};

const getOtpFromFirebase = async (firebase, mobileNumber) => {
  console.log("Otp Triggered !!!");
  let db = firebase.firestore();
  let documentOtpRef = db.collection("cowin-mobile-otp").doc(mobileNumber);
  console.log(mobileNumber);

  const pollFirebaseForOtp = async () => {
    let attempts = 0;
    const maxAttempts = 10;
    let otp = null;
    while (otp == null && attempts < maxAttempts) {
      otp = await pollFirebase(documentOtpRef);
      attempts++;
      console.log("Attempts otp , ", attempts, otp);
    }
    if (attempts === maxAttempts) {
      throw new Error("All attempts done!!!!");
    }
    return otp;
    //return pollFirebase();
  };

  let otp;
  try {
    otp = await pollFirebaseForOtp();
  } catch (err) {
    console.log("Error in getting otp, ", err);
  }

  documentOtpRef
    .delete()
    .then(() => {
      console.log("Current otp successfully deleted!");
    })
    .catch((error) => {
      console.error("Error in removing document: ", error);
    });

  console.log("Returning OTP : ", otp);
  return otp;
};

const pollFirebase = async (documentOtpRef) => {
  let otp = await getDataFromFirebase(documentOtpRef);
  console.log("Otp from fireabse is ", otp);

  if (otp != null) {
    return otp;
  } else {
    // setTimeout(pollFirebase, 15000);
    return await sleep(15000);
  }
};

const getDataFromFirebase = (documentOtpRef) => {
  return new Promise((res, rej) => {
    documentOtpRef
      .get()
      .then((doc) => {
        if (doc.exists) {
          console.log("Mobile Otp db data:", doc.data());
          res(doc.data().otp);
        } else {
          console.log("Mobile Otp not found!");
          res();
        }
      })
      .catch((error) => {
        console.log("Error getting document:", error);
        res();
      });
  });
};

const validateOtp = async (userInputOtp) => {
  // const userInputOtp = await waitForUserInput("Enter OTP: ");
  const otp = CryptoJS.SHA256(userInputOtp).toString();
  const payload = {
    txnId,
    otp,
  };

  var headers = baseHeaders;
  try {
    var response = await axios.post(`${basePath}${confirmOtpPath}`, payload, {
      headers,
    });
  } catch (err) {
    console.error("Error in getting token ", err);
  }
  token = response.data.token;
  return Promise.resolve(token);
};

const waitForUserInput = (message) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(message, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
};

const insertTokenManually = async () => {
  token = await waitForUserInput("Enter Token: ");
  return Promise.resolve(true);
};

const findSlotsPerDistrict = async (districtId, date) => {
  var headers = baseHeaders;
  try {
    var response = await axios.get(
      `${basePath}${findByDistrictPath}?district_id=${districtId}&date=${date}`,
      { headers }
    );
    return Promise.resolve(filterOutRelevantHospitals(response.data));
  } catch (e) {
    console.error(e);
  }
};

const filterOutRelevantHospitals = (data) => {
  return data.sessions.filter((session) => {
    try {
      const pincodeList = config.pincodes;
      const allowedCenters = config.allowedCenters;
      const centersFilter = config.allowedCentersFilter;
      const vaccinesFilter = config.vaccineTypeFilter;
      const allowedVaccines = config.allowedVaccines;
      if (
        session.min_age_limit <= 25 &&
        session.available_capacity_dose1 >= 5 &&
        (vaccinesFilter && allowedVaccines.includes(session.vaccine))
        (centersFilter && allowedCenters.includes(session.center_id))
        (pincodeList.includes(session.pincode) || !config.override_pincodes)
      ) {
        return true;
      }
      return false;
    } catch (e) {
      console.log(e);
      return false;
    }
  });
};

const getCaptcha = async () => {
  var headers = {
    ...baseHeaders,
    Authorization: "Bearer " + token,
  };
  try {
    var response = await axios.post(
      `${basePath}${getRecaptch}`,
      {},
      { headers }
    );
    // fs.writeFileSync("./assets/captcha.svg", response.data.captcha);
    // open("./assets/captcha.svg");
    // captcha = await waitForUserInput("Enter Captcha: ");
    return Promise.resolve(true);
  } catch (e) {
    console.log(e);
    return Promise.resolve(true);
  }
};

const bookAppointmentForSlot = async (center_id, session_id, slot) => {
  const payload = {
    dose: 1,
    center_id,
    session_id,
    slot,
    beneficiaries,
    captcha,
  };

  console.log("Payload", payload)

  const headers = {
    ...baseHeaders,
    Authorization: "Bearer " + token,
  };
  try {
    const response = await axios.post(
      `${basePath}${appointmentSchedule}`,
      payload,
      { headers }
    );
    console.log(response.data);
  } catch (e) {
    console.log(e);
    return Promise.resolve(false);
  }
  bookingDone = true
  return Promise.resolve(true);
};

const bookAppointmentHandler = async (arr) => {
  let isCaptchaHere = false;
  while (!isCaptchaHere) {
    isCaptchaHere = await getCaptcha();
    if (captcha === "reset") {
      isCaptchaHere = false;
    }
  }
  session = arr[0];
  for (let slot of session.slots) {
    let isSessionBooked = await bookAppointmentForSlot(
      session.center_id,
      session.session_id,
      slot
    );
    if (isSessionBooked) {
      break;
    }
  }
  return Promise.resolve(true);
};

const playAlert = () => {
  player.play({ path: "./assets/alert.wav" }).then(() => {
    console.log("ALERT: slot found");
  });
};

const loginReminder = () => {
  notifier.notify("Please refresh cowin token: ");
  player.play({ path: "./assets/alarm.wav" });
};

const scheduleTask = async (districtId, date) => {
  let arr = await findSlotsPerDistrict(districtId, date);
  // console.log('Checked: ' + arr.length);
  try {
    if(arr.length > 0) {
      console.log("OPEN", arr)
    }
    if (arr.length > 0 && !bookingDone) {
      if (!lock) {
        lock = true;
        playAlert();
        console.log(arr);
        await bookAppointmentHandler(arr);
        lock = false;
      }
    }
  } catch (e) {
    console.error(e);
  }
};

const scheduleUpdateToken = async (firebase) => {
  // loginReminder();
  await triggerRegistration(config.registeredNumber);
  let userInputOtp = await getOtpFromFirebase(
    firebase,
    config.registeredNumber
  );
  await validateOtp(userInputOtp);
  await findYo();
};

const findYo = async () => {
  var headers = {
    ...baseHeaders,
    Authorization: "Bearer " + token,
  };
  console.log(token)
  try {
    var response = await axios.get(
      `https://cdn-api.co-vin.in/api/v2/appointment/beneficiaries`,
      { headers }
    );
    console.log(response.data);
    var newBeneficiaries = [];
    for (let ben of response.data.beneficiaries) {
      newBeneficiaries.push(ben.beneficiary_reference_id);
    }
    beneficiaries = newBeneficiaries;
    if (config.override_beneficiaries) {
      beneficiaries = config.beneficiaries;
    }
    console.log(beneficiaries);
  } catch (e) {
    console.log(e);
  }
};

const sleep = (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const init = async () => {
  let firebaseConfig = Auth.firebaseAuth;

  firebase.initializeApp(firebaseConfig);

  cron.schedule("*/5 * * * * *", () => {
    scheduleTask(config.districtId_1, config.date_1);
    // scheduleTask(config.districtId_2, config.date_2);
  });

  cron.schedule("*/12 * * * *", () => {
    scheduleUpdateToken(firebase);
  });
  await scheduleUpdateToken(firebase);
};

init();


