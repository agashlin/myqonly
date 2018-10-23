const PHABRICATOR_ROOT = "https://phabricator.services.mozilla.com";
const PHABRICATOR_DASHBOARD = "differential/query/active/"
const PHABRICATOR_REVIEW_HEADERS = [
  "Must Review",
  "Ready to Review",
];
const MULTI_ACCOUNT_CONTAINERS_EXTENSION_ID = "@testpilot-containers";
const BUGZILLA_API = "https://bugzilla.mozilla.org/jsonrpc.cgi";
const GITHUB_API = "https://api.github.com/search/issues";

const DEFAULT_UPDATE_INTERVAL = 5; // minutes
const ALARM_NAME = "check-for-updates";

const MyQOnly = {
  /**
   * Main entry. After set-up, attempts to update the badge right
   * away.
   */
  async init() {
    // Add a listener so that if our options change, we react to it.
    browser.storage.onChanged.addListener(this.onStorageChanged.bind(this));
    // Hook up our timer
    browser.alarms.onAlarm.addListener(this.onAlarm.bind(this));
    // Add a listener for the popup if it asks for review totals.
    browser.runtime.onMessage.addListener(this.onMessage.bind(this));

    let { updateInterval } = await browser.storage.local.get("updateInterval");
    if (!updateInterval) {
      await browser.storage.local.set({
        updateInterval: DEFAULT_UPDATE_INTERVAL
      });
    }
    this.updateInterval = updateInterval;

    let { userKeys } = await browser.storage.local.get("userKeys");
    this.userKeys = userKeys || {};

    // Delete the Phabricator API key if the user still has it around,
    // since we don't use this anymore in more recent versions.
    if (this.userKeys.phabricator) {
      console.log("Found an old Phabricator API key - clearing it.");
      delete this.userKeys.phabricator;
      await browser.storage.local.set({
        userKeys: this.userKeys,
      });
      console.log("Old Phabricator API key is cleared.");
    }

    this.reviewTotals = {
      bugzilla: 0,
      phabricator: 0,
      github: 0,
    };

    await this.resetAlarm();
    await this.updateBadge();
  },

  /**
   * Handles updates to the user options.
   */
  async onStorageChanged(changes, area) {
    if (area == "local") {
      // The user updated the update interval, so let's cancel the old
      // alarm and set up a new one.
      if (changes.updateInterval) {
        this.updateInterval = changes.updateInterval.newValue;
        console.log("background.js saw change to updateInterval: " +
                    this.updateInterval);
        this.resetAlarm();
      }

      // The user updated their API keys, so let's go update the badge.
      if (changes.userKeys) {
        this.userKeys = changes.userKeys.newValue;
        console.log("background.js saw change to userKeys");
        await this.updateBadge();
      }
    }
  },

  /**
   * Wipes out any pre-existing alarm and sets up a new one with
   * the current update interval.
   */
  async resetAlarm() {
    let cleared = await browser.alarms.clear(ALARM_NAME);
    if (cleared) {
      console.log("Cleared old alarm");
    }

    console.log("Resetting alarm - will fire in " +
                `${this.updateInterval} minutes`);
    browser.alarms.create(ALARM_NAME, {
      periodInMinutes: this.updateInterval,
    });
  },

  /**
   * Handles messages from the popup.
   */
  onMessage(message, sender, sendReply) {
    if (message.name == "get-reviews") {
      // The popup wants to know how many reviews there are to do.
      sendReply(this.reviewTotals);
    }
  },

  /**
   * The alarm went off! Let's do the badge updating stuff now.
   */
  onAlarm(alarmInfo) {
    if (alarmInfo.name == ALARM_NAME) {
      console.log("Updating the badge now...");
      this.updateBadge();
    }
  },

  async githubReviewRequests(username) {
    // We don't seem to need authentication for this request, for whatever reason.
    let url = new URL(GITHUB_API);
    url.searchParams.set("q", `review-requested:${username} type:pr is:open archived:false`);
    // Note: we might need to paginate if we care about fetching more than the
    // first 100.
    let response = await window.fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github.v3+json"
      },
      // Probably doesn't matter.
      credentials: "omit",
    });
    if (!response.ok) {
      console.error("Failed to request from github", response);
      throw new Error(`Github request failed (${response.status}): ${await response.text()}`);
    }
    const data = await response.json();
    return data.total_count;
  },

  async getCookieStoreForUrl(url) {
    let assignment = await browser.runtime.sendMessage(
      MULTI_ACCOUNT_CONTAINERS_EXTENSION_ID,
      {
        url,
        method: "getAssignment",
      },
      {},
    );

    if (assignment && "userContextId" in assignment) {
      return "firefox-container-" + String(assignment.userContextId);
    } else {
      return null;
    }
  },

  async fetchWithCookies(req, cookies) {
    req.credentials = "omit";

    let cookieStr = cookies.map(pair => `${pair.name}=${pair.value}`).join("; ");
    let originUrl = `${window.origin}/_generated_background_page.html`;

    let headersRewriteListener = details => {
      if (details.originUrl !== originUrl) {
        return {};
      }

      // Remove any cookies.
      let requestHeaders =
        details.requestHeaders.filter(header =>
          header.name.toLowerCase() !== "cookie");

      requestHeaders.push({
        name: "Cookie",
        value: cookieStr,
      });

      return { requestHeaders };
    };

    browser.webRequest.onBeforeSendHeaders.addListener(headersRewriteListener,
      {
        urls: [req.url],
        types: ["xmlhttprequest"],
        tabId: browser.tabs.TAB_ID_NONE,
      },
      ["blocking", "requestHeaders"],
    );
    let resp = await window.fetch(req);
    browser.webRequest.onBeforeSendHeaders.removeListener(headersRewriteListener);
    return resp;
  },

  /**
   * Contacts Phabricator, Bugzilla, and Github (if the API keys for them exist),
   * and attempts to get a review count for each.
   */
  async updateBadge() {
    let reviews = 0;

    // First, let's get Phabricator...
    // We'll start by seeing if we have any cookies.
    let phabCookie = await browser.cookies.get({
      url: PHABRICATOR_ROOT,
      name: "phsid",
    });
    let cookieStoreId = await this.getCookieStoreForUrl(PHABRICATOR_ROOT);

    if (phabCookie || cookieStoreId) {
      console.log("Phabricator session found! Attempting to get dashboard page.");
      let url = [PHABRICATOR_ROOT, PHABRICATOR_DASHBOARD].join("/");
      let req = new Request(url, {
        method: "GET",
        headers: {
          "Content-Type": "text/html",
        },
        redirect: "follow",
      });

      let resp = await window.fetch(req);

      if (!resp.ok && cookieStoreId) {
        // Try to use a login from a container.

        phabCookie = await browser.cookies.get({
          url: PHABRICATOR_ROOT,
          name: "phsid",
          storeId: cookieStoreId,
        });

        if (phabCookie) {
          resp = await this.fetchWithCookies(req.clone(),
            [ {name: "phsid", value: phabCookie.value} ]);
        }
      }

      let pageBody = await resp.text();
      let parser = new DOMParser();
      let doc = parser.parseFromString(pageBody, "text/html");

      let headers = doc.querySelectorAll(".phui-header-header");

      this.reviewTotals.phabricator = 0;

      for (let header of headers) {
        if (PHABRICATOR_REVIEW_HEADERS.includes(header.textContent)) {
          let box = header.closest(".phui-box");
          let rows = box.querySelectorAll(".phui-oi-table-row");
          this.reviewTotals.phabricator += rows.length;
        }
      }

      console.log(`Found ${this.reviewTotals.phabricator} Phabricator reviews to do`);

      reviews += this.reviewTotals.phabricator;
    } else {
      console.log("No Phabricator session found. I won't try to fetch anything for it.");
    }

    // Okay, now Bugzilla's turn...
    if (this.userKeys.bugzilla) {
      // I'm not sure how much of this is necessary - I just looked at what
      // the Bugzilla My Dashboard thing does in the network inspector, and
      // I'm more or less mimicking that here.
      let body = JSON.stringify({
        id: 4,
        method: "MyDashboard.run_flag_query",
        params: {
          Bugzilla_api_key: this.userKeys.bugzilla,
          type: "requestee",
        },
        version: "1.1",
      });

      let req = new Request(BUGZILLA_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body,
        credentials: "omit",
        redirect: "follow",
        referrer: "client"
      });

      let resp = await window.fetch(req);
      let bugzillaData = await resp.json();
      if (bugzillaData.error) {
        console.error("Failed to get Bugzilla reviews: ",
                      bugzillaData.error.message);
      } else {
        this.reviewTotals.bugzilla =
          bugzillaData.result.result.requestee.filter(f => {
            return f.type == "review"
          }).length;
        console.log(`Found ${this.reviewTotals.bugzilla} ` +
                    "Bugzilla reviews to do");
        reviews += this.reviewTotals.bugzilla;
      }
    }

    // Now, check github.
    if (this.userKeys.ghuser) {
      try {
        this.reviewTotals.github =
          await this.githubReviewRequests(this.userKeys.ghuser);
        reviews += this.reviewTotals.github;
        console.log(`Found ${this.reviewTotals.github} Github reviews to do`);
      } catch (e) {
        // It would be nice to surface this to the user more directly.
        console.error("Error when fetching github issues:", e);
      }
    }

    console.log(`Found a total of ${reviews} reviews to do`)
    if (!reviews) {
      browser.browserAction.setBadgeText({ text: null });
    } else {
      browser.browserAction.setBadgeText({ text: String(reviews) });
    }
  },
};

MyQOnly.init();
