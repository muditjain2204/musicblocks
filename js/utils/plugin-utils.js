// Copyright (c) 2014-25 Walter Bender
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the The GNU Affero General Public
// License as published by the Free Software Foundation; either
// version 3 of the License, or (at your option) any later version.
//
// You should have received a copy of the GNU Affero General Public
// License along with this library; if not, write to the Free Software
// Foundation, 51 Franklin Street, Suite 500 Boston, MA 02110-1335 USA

/*
   globals

   platformColor, i18next
*/

if (typeof module !== "undefined" && module.exports) {
    var UtilsLogic =
        (typeof window !== "undefined" && window.UtilsLogic) ||
        (typeof require !== "undefined" ? require("./utils-logic") : {});
    var { isUnsafeObjectKey } = UtilsLogic;
}

/**
 * Returns true for plain non-null, non-array objects.
 * @param {*} value - The value to check.
 * @returns {boolean}
 */
const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Iterates own enumerable entries of a plain object while skipping unsafe keys.
 * @param {*} section - Candidate plugin section object.
 * @param {function(string, *): void} fn - Callback invoked for each safe entry.
 */
const forEachSafeEntry = (section, fn) => {
    if (!isPlainObject(section)) {
        return;
    }
    for (const key of Object.keys(section)) {
        if (isUnsafeObjectKey(key)) continue;
        fn(key, section[key]);
    }
};

/**
 * Reads a safe own property from an optional plain object, or returns a fallback.
 * @param {*} section - Candidate section object.
 * @param {string} key - Property name to look up.
 * @param {*} fallback - Fallback value when missing.
 * @returns {*}
 */
const getSafeSectionValue = (section, key, fallback) =>
    isPlainObject(section) && Object.prototype.hasOwnProperty.call(section, key)
        ? section[key]
        : fallback;

const PLUGIN_OBJECT_SECTIONS = [
    "PALETTEPLUGINS",
    "PALETTEFILLCOLORS",
    "PALETTESTROKECOLORS",
    "PALETTEHIGHLIGHTCOLORS",
    "FLOWPLUGINS",
    "ARGPLUGINS",
    "BLOCKPLUGINS",
    "MACROPLUGINS",
    "IMAGES",
    "ONLOAD",
    "ONSTART",
    "ONSTOP"
];

/**
 * Processes plugin data and updates the activity based on the provided JSON-encoded dictionary.
 * @param {object} activity - The activity object to update.
 * @param {string} pluginData - The JSON-encoded plugin data.
 * @returns {object|null} The processed plugin data object or null if parsing fails.
 */
const processPluginData = async (activity, pluginData, pluginSource) => {
    // Plugins are JSON-encoded dictionaries.
    if (pluginData === undefined) {
        return null;
    }

    const isVettedPlugin = source => {
        if (!source) return false;
        // Plugins from the local plugins folder are considered vetted (provenance)
        if (source.startsWith("plugins/") || source.startsWith("./plugins/")) {
            return true;
        }
        // Known plugins from local storage are also trusted as they were approved previously
        if (source === "localStorage:plugins") {
            return true;
        }
        return false;
    };

    // Use the vetted check to determine initial trust
    let userConfirmed = isVettedPlugin(pluginSource);

    if (!userConfirmed) {
        userConfirmed = confirm(
            _("Security Warning") +
                "\n\n" +
                _(
                    "This plugin contains code that will be executed in your browser. It has not been loaded from the built-in plugins directory and may contain unsafe code."
                ) +
                "\n\n" +
                _("Do you want to allow this plugin to run?") +
                "\n\n" +
                _("Source: %s").replace(/%s/g, () => pluginSource || _("unknown"))
        );

        if (!userConfirmed) {
            console.warn("User declined unvetted plugin execution:", pluginSource);
            return null;
        }
    }

    // We accumulate scripts that need to be executed in a Blob URL to avoid unsafe-eval.
    let blobScriptContent = "";
    const pendingSafeEvals = [];

    const safeEval = (code, label = "plugin") => {
        if (typeof code !== "string" || !userConfirmed) return;

        // Basic sanity limit
        if (code.length > 500000) {
            console.warn("Plugin code too large:", label);
            return;
        }

        // Fix for Chrome CSP which blocks Function("return this")() typically found in webpack bundles
        code = code.replace(
            /(?:new\s+)?Function\s*\(\s*['"]return this['"]\s*\)\s*\(\)/g,
            "window"
        );

        // We wrap the code in a closure that provides activity and globalActivity.
        // We'll execute these after the Blob script is loaded and populates the registry.
        pendingSafeEvals.push({ code, label });
    };

    let obj;
    try {
        obj = JSON.parse(pluginData);
    } catch (error) {
        console.error(
            `PluginProcessor: Failed to parse plugin data from source "${pluginSource}":`,
            error
        );
        console.debug("Malformed plugin data:", pluginData);
        return null;
    }

    if (!isPlainObject(obj)) {
        console.error(
            `PluginProcessor: Expected plugin object from source "${pluginSource}", got ${
                Array.isArray(obj) ? "array" : typeof obj
            }`
        );
        return null;
    }

    // Create a palette entry.
    let newPalette = false,
        paletteName = null;
    const fillColors = obj["PALETTEFILLCOLORS"];
    const strokeColors = obj["PALETTESTROKECOLORS"];
    const highlightColors = obj["PALETTEHIGHLIGHTCOLORS"];
    const highlightStrokeColors = obj["HIGHLIGHTSTROKECOLORS"];

    forEachSafeEntry(obj["PALETTEPLUGINS"], (name, icon) => {
        paletteName = name;
        PALETTEICONS[name] = icon;
        const fillColor = getSafeSectionValue(fillColors, name, "#ff0066");
        PALETTEFILLCOLORS[name] = fillColor;
        const strokeColor = getSafeSectionValue(strokeColors, name, "#ef003e");
        PALETTESTROKECOLORS[name] = strokeColor;
        const highlightColor = getSafeSectionValue(highlightColors, name, "#ffb1b3");
        PALETTEHIGHLIGHTCOLORS[name] = highlightColor;
        const strokeHighlightColor = getSafeSectionValue(highlightStrokeColors, name, "#404040");
        HIGHLIGHTSTROKECOLORS[name] = strokeHighlightColor;

        platformColor.paletteColors[name] = [
            fillColor,
            strokeColor,
            highlightColor,
            strokeHighlightColor
        ];

        if (name in activity.palettes.buttons) {
            console.debug("palette " + name + " already exists");
        } else {
            console.debug("adding palette " + name);
            activity.palettes.add(name);
            if (!MULTIPALETTES[2].includes(name)) MULTIPALETTES[2].push(name);
            newPalette = true;
        }
    });

    if (newPalette) {
        try {
            // console.debug("Calling makePalettes");
            activity.palettes.makePalettes(1);
        } catch (e) {
            console.debug("makePalettes: " + e);
        }
    }

    // Define the image blocks
    forEachSafeEntry(obj["IMAGES"], (blkName, imageData) => {
        activity.pluginsImages[blkName] = imageData;
    });

    // Populate the flow-block dictionary, i.e., the code that is
    // compiled into a function for hot-path execution.
    forEachSafeEntry(obj["FLOWPLUGINS"], (flow, flowCode) => {
        // Pre-compile trusted plugins for performance.
        // UNTRUSTED plugins (if any made it past confirmation) are stored as strings
        // and handled via whitelist in safePluginExecute.
        if (isVettedPlugin(pluginSource)) {
            const registryName = `flow_${flow}_${Math.random().toString(36).slice(2, 11)}`;
            blobScriptContent += `
window.__mb_plugin_registry["${registryName}"] = function(logo, turtle, blk, receivedArg, actionArgs, args, isflow) {
    ${flowCode}
};
`;
            activity.logo.evalFlowDict[flow] = registryName; // Will be replaced by function after load
        } else {
            activity.logo.evalFlowDict[flow] = flowCode;
        }
    });

    // Populate the arg-block dictionary
    forEachSafeEntry(obj["ARGPLUGINS"], (arg, argCode) => {
        if (isVettedPlugin(pluginSource)) {
            const registryName = `arg_${arg}_${Math.random().toString(36).slice(2, 11)}`;
            blobScriptContent += `
window.__mb_plugin_registry["${registryName}"] = function(logo, turtle, blk, parentBlk, receivedArg, tur) {
    ${argCode}
};
`;
            activity.logo.evalArgDict[arg] = registryName;
        } else {
            activity.logo.evalArgDict[arg] = argCode;
        }
    });

    // Populate the macro dictionary, i.e., the code that is
    // eval'd by this block.
    forEachSafeEntry(obj["MACROPLUGINS"], (macro, macroData) => {
        try {
            activity.palettes.pluginMacros[macro] = JSON.parse(macroData);
        } catch (e) {
            console.debug("could not parse macro " + macro);

            console.debug(e);
        }
    });

    // Populate the setter dictionary
    forEachSafeEntry(obj["SETTERPLUGINS"], (setter, setterCode) => {
        if (isVettedPlugin(pluginSource)) {
            const registryName = `setter_${setter}_${Math.random().toString(36).slice(2, 11)}`;
            blobScriptContent += `
window.__mb_plugin_registry["${registryName}"] = function(logo, blk, value, turtle) {
    ${setterCode}
};
`;
            activity.logo.evalSetterDict[setter] = registryName;
        } else {
            activity.logo.evalSetterDict[setter] = setterCode;
        }
    });

    // Create the plugin protoblocks.
    forEachSafeEntry(obj["BLOCKPLUGINS"], (block, blockCode) => {
        console.debug("adding plugin block " + block);
        safeEval(blockCode, "BLOCKPLUGINS:" + block);
    });

    // Create the globals.
    if ("GLOBALS" in obj) {
        safeEval(obj["GLOBALS"], "GLOBALS");
    }

    forEachSafeEntry(obj["PARAMETERPLUGINS"], (parameter, paramCode) => {
        if (isVettedPlugin(pluginSource)) {
            const registryName = `param_${parameter}_${Math.random().toString(36).slice(2, 11)}`;
            blobScriptContent += `
window.__mb_plugin_registry["${registryName}"] = function(logo, turtle, blk) {
    ${paramCode}
};
`;
            activity.logo.evalParameterDict[parameter] = registryName;
        } else {
            activity.logo.evalParameterDict[parameter] = paramCode;
        }
    });

    // Code to execute when plugin is loaded
    forEachSafeEntry(obj["ONLOAD"], (arg, onLoadCode) => {
        safeEval(onLoadCode, "ONLOAD:" + arg);
    });

    // Code to execute when turtle code is started
    forEachSafeEntry(obj["ONSTART"], (arg, onStartCode) => {
        if (isVettedPlugin(pluginSource)) {
            const registryName = `onstart_${arg}_${Math.random().toString(36).slice(2, 11)}`;
            blobScriptContent += `
window.__mb_plugin_registry["${registryName}"] = function(logo) {
    ${onStartCode}
};
`;
            activity.logo.evalOnStartList[arg] = registryName;
        } else {
            activity.logo.evalOnStartList[arg] = onStartCode;
        }
    });

    // Code to execute when turtle code is stopped
    forEachSafeEntry(obj["ONSTOP"], (arg, onStopCode) => {
        if (isVettedPlugin(pluginSource)) {
            const registryName = `onstop_${arg}_${Math.random().toString(36).slice(2, 11)}`;
            blobScriptContent += `
window.__mb_plugin_registry["${registryName}"] = function(logo) {
    ${onStopCode}
};
`;
            activity.logo.evalOnStopList[arg] = registryName;
        } else {
            activity.logo.evalOnStopList[arg] = onStopCode;
        }
    });

    // Now execute the Blob script injection if we have collected any trusted code
    if (blobScriptContent) {
        window.__mb_plugin_registry = window.__mb_plugin_registry || {};
        const fullScript = `
(function() {
    window.__mb_plugin_registry = window.__mb_plugin_registry || {};
    ${blobScriptContent}
})();
`;
        const blob = new Blob([fullScript], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        const script = document.createElement("script");
        script.src = url;

        await new Promise((resolve, reject) => {
            script.onload = () => {
                URL.revokeObjectURL(url);
                document.head.removeChild(script);
                resolve();
            };
            script.onerror = e => {
                URL.revokeObjectURL(url);
                document.head.removeChild(script);
                const err = new Error(
                    "Failed to load plugin script" + (e && e.message ? ": " + e.message : "")
                );
                console.error("Failed to load CSP Blob script for plugins", err);
                reject(err);
            };
            document.head.appendChild(script);
        });

        // Map Registry back to dictionaries
        const mapDict = dict => {
            for (const key in dict) {
                if (typeof dict[key] === "string" && dict[key].indexOf("_") !== -1) {
                    const registryName = dict[key];
                    if (window.__mb_plugin_registry[registryName]) {
                        dict[key] = window.__mb_plugin_registry[registryName];
                        delete window.__mb_plugin_registry[registryName];
                    }
                }
            }
        };

        mapDict(activity.logo.evalFlowDict);
        mapDict(activity.logo.evalArgDict);
        mapDict(activity.logo.evalSetterDict);
        mapDict(activity.logo.evalParameterDict);
        mapDict(activity.logo.evalOnStartList);
        mapDict(activity.logo.evalOnStopList);
    }

    // Finally, execute safeEvals by creating new Blob scripts for each setup logic block.
    // This is because even setup logic can be blocked by CSP if it contains unsafe-eval.
    window.__mb_plugin_registry = window.__mb_plugin_registry || {};
    for (const item of pendingSafeEvals) {
        const registryName = `setup_${item.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Math.random()
            .toString(36)
            .slice(2, 11)}`;
        const setupScript = `
window.__mb_plugin_registry = window.__mb_plugin_registry || {};
window.__mb_plugin_registry["${registryName}"] = function(activity, globalActivity) {
    ${item.code}
};
`;
        const sBlob = new Blob([setupScript], { type: "application/javascript" });
        const sUrl = URL.createObjectURL(sBlob);
        const sScript = document.createElement("script");
        sScript.src = sUrl;
        await new Promise((resolve, reject) => {
            sScript.onload = () => {
                if (window.__mb_plugin_registry[registryName]) {
                    try {
                        window.__mb_plugin_registry[registryName](activity, activity);
                    } catch (e) {
                        console.error("Plugin setup failed:", item.label, e);
                    }
                    delete window.__mb_plugin_registry[registryName];
                }
                URL.revokeObjectURL(sUrl);
                if (sScript.parentNode) {
                    sScript.parentNode.removeChild(sScript);
                }
                resolve();
            };
            sScript.onerror = e => {
                URL.revokeObjectURL(sUrl);
                if (sScript.parentNode) {
                    sScript.parentNode.removeChild(sScript);
                }
                const err = new Error(
                    "Failed to execute plugin script" + (e && e.message ? ": " + e.message : "")
                );
                reject(err);
            };
            document.head.appendChild(sScript);
        });
    }

    for (const protoblock in activity.blocks.protoBlockDict) {
        try {
            // Push the protoblocks onto their palettes.
            if (activity.blocks.protoBlockDict[protoblock].palette === undefined) {
                console.debug("Cannot find palette for protoblock " + protoblock);
            } else if (activity.blocks.protoBlockDict[protoblock].palette === null) {
                console.debug("Cannot find palette for protoblock " + protoblock);
            } else {
                activity.blocks.protoBlockDict[protoblock].palette.add(
                    activity.blocks.protoBlockDict[protoblock]
                );
            }
        } catch (e) {
            console.debug(e);
        }
    }

    if (paletteName !== null) {
        // console.debug("updating palette " + paletteName);
        activity.palettes.updatePalettes(paletteName);
    }

    setTimeout(() => {
        activity.palettes.show();
    }, 2000);

    // Return the object in case we need to save it to local storage.
    return obj;
};

/**
 * Processes raw plugin data, removes blank lines and comments, and then calls `processPluginData` to update the activity.
 * @async
 * @param {object} activity - The activity object to update.
 * @param {string} rawData - Raw plugin data to process.
 * @returns {Promise<object|null>} The processed plugin data object or null if parsing fails.
 */
const processRawPluginData = async (activity, rawData, pluginSource) => {
    const lineData = rawData.split("\n");
    let cleanData = "";

    // We need to remove blank lines and comments and then
    // join the data back together for processing as JSON.
    for (let i = 0; i < lineData.length; i++) {
        if (lineData[i].length === 0) {
            continue;
        }

        if (lineData[i][0] === "/") {
            continue;
        }

        cleanData += lineData[i];
    }

    // Note to plugin developers: You may want to comment out this
    // try/catch while debugging your plugin.
    let obj;
    try {
        obj = await processPluginData(activity, cleanData.replace(/\n/g, ""), pluginSource);
    } catch (e) {
        obj = null;

        console.debug(rawData);

        console.debug(cleanData);
        activity.errorMsg("Error loading plugin: " + e);
    }

    return obj;
};

/**
 * Updates the plugin objects with data from the processed plugin data object.
 * @param {object} activity - The activity object to update.
 * @param {object} obj - The processed plugin data object.
 */
const updatePluginObj = (activity, obj) => {
    if (!isPlainObject(obj)) {
        return;
    }

    for (const section of PLUGIN_OBJECT_SECTIONS) {
        if (!isPlainObject(obj[section])) {
            continue;
        }
        if (!isPlainObject(activity.pluginObjs[section])) {
            activity.pluginObjs[section] = {};
        }
        forEachSafeEntry(obj[section], (key, value) => {
            activity.pluginObjs[section][key] = value;
        });
    }

    if (typeof obj["GLOBALS"] === "string") {
        if (typeof activity.pluginObjs["GLOBALS"] !== "string") {
            activity.pluginObjs["GLOBALS"] = "";
        }
        activity.pluginObjs["GLOBALS"] += obj["GLOBALS"];
    }
};

/**
 * Prepares the plugin exports by updating the plugin objects and returning them as JSON-encoded text.
 * @param {object} activity - The activity object.
 * @param {object} obj - The processed plugin data object.
 * @returns {string} The JSON-encoded text of the updated plugin objects.
 */
let preparePluginExports = (activity, obj) => {
    // add obj to plugin dictionary and return as JSON encoded text
    updatePluginObj(activity, obj);

    return JSON.stringify(activity.pluginObjs);
};

if (typeof window !== "undefined" && (typeof module === "undefined" || !module.exports)) {
    window.PluginUtils = {
        processPluginData,
        processRawPluginData,
        updatePluginObj,
        preparePluginExports
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        processPluginData,
        processRawPluginData,
        updatePluginObj,
        preparePluginExports
    };
}
