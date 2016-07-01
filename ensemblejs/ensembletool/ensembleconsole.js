/*global console, require, requirejs, document, Promise */
require.nodeRequire = window.requireNode;
requirejs.config({
	paths: {
		"domReady": "../jslib/domReady"
		// JS libraries
		,"jquery": "../jslib/jquery-2.1.0"
		,"jqueryUI": "../jslib/jquery-ui.min"

		,"test": "../js/tests/Tests"
		,"text": "../jslib/text"	// Lets require load plain text, used by jsx

		// Custom libraries
		,"underscore" : "../jslib/underscore-min"
		,"util": "../jslib/util"
		,"log": "../jslib/log"

		// ensemble
		,"ensemble" : "../js/ensemble/ensemble"
		,"socialRecord" : "../js/ensemble/SocialRecord"
		,"ruleLibrary" : "../js/ensemble/RuleLibrary"
		,"volition": "../js/ensemble/Volition"
		,"validate": "../js/ensemble/Validate"
		,"actionLibrary": "../js/ensemble/ActionLibrary"

		// Tool
		,"historyViewer" : "historyViewer"
		,"rulesViewer" : "rulesViewer"
		,"rulesEditor" : "rulesEditor"
		,"consoleViewer" : "consoleViewer"
		,"messages" : "messages"
		,"ruleTester" : "ruleTester"
		,"fileio" : "fileio"
		// ,"ui" : "ui"


},

	// Shims let certain libraries that aren't built with the module pattern interface with require.js 
	// Basically they tell require.js what global variable the given library will try to export all its functionality to, so require.js can do with that what it will.
	shim : {
		"underscore" : {
			exports : "_"
		},
		"jqueryUI" : {
			exports : '$',
			deps	: ['jquery']
		}
	}
});

requirejs(["ensemble", "socialRecord", "actionLibrary", "historyViewer", "rulesViewer", "rulesEditor", "consoleViewer", "ruleTester", "fileio", "jquery", "util", "text!../data/socialData.json", "text!../data/ensemble-test-chars.json", "text!../data/testState.json", "text!../data/testTriggerRules.json", "text!../data/testVolitionRules.json", "text!../data/consoleDefaultActions.json", "messages", "jqueryUI", "domReady!"], 
function(ensemble, socialRecord, actionLibrary, historyViewer, rulesViewer, rulesEditor, consoleViewer, ruleTester, fileio, $, util, sampleData, sampleChars, testSfdbData, testTriggerRules, testVolitionRules, testActions, messages){

	var autoLoad = false;	// Load sample schema package on launch.

	var socialStructure;
	var characters;
	var fullCharacters;
	var skipBackup = "skip"; // helper variable to skip backuping up files when creating a new rule.

	var maxBackupFiles = 10;

	// stores the origins of all loaded rules.
	// For now, we assume that the fileName field within the rule matches the filename of the file it came from. TODO: possible to do this automatically?
	var ruleOriginsTrigger = [];
	var ruleOriginsVolition = [];

	var fs;
	try {
		fs = require('fs');
	} catch (e) {
		// If running in webbrowser, ignore.
	}

	// ****************************************************************
	// UI SETUP
	// ****************************************************************

	// Refresh the history view pane whenever we switch to it.
	$("#tabs").tabs({
		activate: function( event, ui ) {
			if (ui.newPanel[0].id === "tabsSfdb") {
				historyViewer.refresh(socialRecord.getCurrentTimeStep());
			}
		}
	});

	// Activate tabs to switch between rulesets in Rules pane.
	$("#rulesTabs").tabs({
		activate: function(event, ui) {
			var tabName = ui.newTab[0].innerText;
			$("#newRuleButton").html("New " + tabName + " Rule");
		}
	}).addClass( "ui-tabs-vertical ui-helper-clearfix" );

	var loadSchemaButton = function() {
		if (fs === undefined) {
			// TODO move this into fileio
			alert("File I/O is only possible in the standalone Ensemble app.");
		} else {
			loadPackage();
			$("#loadSchema").blur();
		}
	}

	// Setup interface buttons.
	$("button#timeStepForward").click(historyViewer.stepForward);
	$("button#timeStepBack").click(historyViewer.stepBack);
	$("button#resetSFDBHistory").click(historyViewer.reset);

	$("button#loadSchema").click(loadSchemaButton);

	// Handle clicking on the "New Rule" button: create a new stub rule, register it with ensemble, load it into the editor, and switch to that tab.
	var newRule = function() {
		var type = $("#tabstrigger").is(":visible") ? "trigger" : "volition";

		var newRule = {};
		newRule.name = "New " + util.iCap(type) + " Rule";
		newRule.conditions = [];
		newRule.effects = [];
		
		var ruleWrapper = {};
		ruleWrapper.fileName = "__NEWRULE__";
		ruleWrapper.rules = [newRule];
		ruleWrapper.type = type;
		
		//BEN START HERE
		var newIds = ensemble.addRules(ruleWrapper);
		console.log("Here is newIds... " , newIds);
		var ensembleRule = ensemble.getRuleById(newIds[0]);
		if(ensembleRule === false){
			//Something bad happened where the rule apparantly wasn't added correctly. Abort and show an error.
			messages.showError("Canceling New Rule: Error adding empty new rule to ensemble");
			return;
		}
		var newLoadedRule = ensemble.getRuleById(newIds[0]);
		newLoadedRule.type = type;
		rulesEditor.loadRule(newLoadedRule, type);
		

		//BEN ALSO START HERE!
		//Try to programmatically click the 'update rule eset button' here...
		//pass in 'true' to signify we should opt out of making a backup file.
		rulesEditor.save(skipBackup);
		$("#tabLiRulesEditor a").click();
	};

	$("#newRuleButton").click(newRule);

	// Handle message block.
	$("#msgBlock").click(function(){
		$(this).stop(true,true).fadeOut();
	});

	// ****************************************************************
	// UTILITY FUNCTIONS
	// ****************************************************************



	// Return a string uniquely identifying this date and time with minute accuracy, to be part of a filename timestamp, a la:
	// 14-03-26-1130
	var getDateTimeStamp = function() {
		var d = new Date();
		var stamp = (d.getFullYear() - 2000) + "-";
		var m = d.getMonth() + 1;
		stamp += (m < 10 ? ("0" + m) : m) + "-";
		var day = d.getDate();
		stamp += (day < 10 ? ("0" + day) : day) + "-";
		var h = d.getHours();
		stamp += (h < 10 ? ("0" + h) : h);
		var min = d.getMinutes();
		stamp += (min < 10 ? ("0" + min) : min);
		return stamp;
	};


	// ****************************************************************
	// SAVE / LOAD
	// ****************************************************************


	// Create a timestamped backup file for the given ruleFile, deleting old backups if there are more than maxBackupFiles of them for this file.
	var backupRulesFile = function(ruleFile) {

		// If we don't have filesystem access (perhaps because we're running in a browser), skip.
		if (fs === undefined) {
			return;
		}

		//Make this path that we've found equal to 'lastPath'
		//Also might be helpful with setting a 'default' schema package location.
		var path2 = process.execPath;
		console.log("PATH: " , path2);
		path2 = path2.split("ensemble Tool")[0];
		console.log("nicer path: " , path2);

		var path = lastPath;
		var backupFolderName = "_bak_" + ruleFile;
		var backupPath = path + "/" + backupFolderName;
		var origFilePath = path + "/" + ruleFile + ".json";
		var backupFilePath = backupPath + "/" + ruleFile + "_" + getDateTimeStamp() + ".json";

		// If we can't find the original ruleFile, bail.
		if (!fs.existsSync(origFilePath)) {
			console.log("Can't create backup file for '" + origFilePath + "' because can't find the original file.");
			return;
		}

		// Create a backup folder for the current schema package, if none exists
		if (!fs.existsSync(backupPath)) {
			fs.mkdirSync(backupPath);
			// console.log("Making folder at ", backupPath);
		}

		// Cycle backup files if we have too many.
		var backupFiles = fs.readdirSync(backupPath);
		// Only consider files in this directory as counting towards the maximum if they start with the master filename and end with .json
		backupFiles = backupFiles.filter(function(f) {
			return f.split("_")[0] === ruleFile && f.substr(f.length - 5) === ".json";
		});
		if (backupFiles.length > maxBackupFiles) {
			// Since our timestamp will make files sort alphabetically by earliest to latest, we can get the oldest file by just getting the first entry in the sorted file list.
			backupFiles.sort();
			var oldestFileName = backupFiles[0];
			// console.log("More than maxBackupFiles files (" + maxBackupFiles + "), so deleting oldest file: " + oldestFileName);
			// "unlink" means delete
			fs.unlinkSync(backupPath + "/" + oldestFileName);
		}

		// Copy the current version of the rules file to the backup folder, giving it a named timestamp.
		// console.log("copying '" + origFilePath + "' to '" + backupFilePath);		
		var f = fs.readFileSync(origFilePath);
		fs.writeFileSync(backupFilePath, f);
	};


	// Take a rules type (like "volition" etc.) and a filename, and write out all the rules ensemble has of that type and matching that filename origin to the file in question.
	var writeRulesForFileToDisk = function(ruleTypeShort, ruleFile) {
		
		var rules = ensemble.getRules(ruleTypeShort);

		// Filter rules to only contain rules from the target file.
		var filteredRules = rules.filter(function(rule) {
			return rule.origin === ruleFile;
		});

		// console.log(filteredRules.length + " matching rules from this file");

		// Create a human-readable JSON string encoding the rules in the proper format.
		var preparedRulesObj = {};
		preparedRulesObj.fileName = ruleFile;
		preparedRulesObj.type = ruleTypeShort;
		preparedRulesObj.rules = filteredRules;
		// Convert to a string, using tabs to keep human readable.
		var serializedRules = JSON.stringify(preparedRulesObj, null, '\t');

		// Write the serialized rules to disk.
		var path = lastPath + "/" + ruleFile + ".json";
		if (fs !== undefined) {
			fs.writeFileSync(path, serializedRules);
			// console.log("writing to '" + path + "':");
		}
	};

	var updateConsole = function() {
		consoleViewer.updateRefs(ensemble, socialRecord, characters, fullCharacters, socialStructure); // TODO this also needs to happen when a new schema is loaded.
	}

	// Save a subset of rules from a particular type and specified origin file back out to that file on disk. Delegate to backupRulesFile() to handle backing up the original file first, and writeRulesForFileToDisk() to do the file i/o.
	// NOTE: must be defined before we call rulesEditor.init()
	var saveRules = function(ruleType, ruleFile, optOrigActiveFile, optSkipBackup) {

		if(optSkipBackup !== skipBackup){
			backupRulesFile(ruleFile);
		}

		var ruleTypeShort;
		if (ruleType === "triggerRules" || ruleType === "trigger") {
			ruleTypeShort = "trigger";
		} else {
			ruleTypeShort = "volition";
		}

		writeRulesForFileToDisk(ruleTypeShort, ruleFile);

		// If we've moved a rule from one active file to another, we need to update the old file, too (to remove the moved file).
		if (optOrigActiveFile !== undefined && optOrigActiveFile.trim() !== "" && optOrigActiveFile != ruleFile) {
			// console.log("optOrigActiveFile is " + optOrigActiveFile + " and is different from ruleFile: " + ruleFile + ", so let's back it up too.")
			backupRulesFile(optOrigActiveFile);
			writeRulesForFileToDisk(ruleTypeShort, optOrigActiveFile);
		}
	};

	var resetTool = function() {
		ensemble.reset();
		ruleOriginsTrigger = [];
		ruleOriginsVolition = [];
		historyViewer.reset();
		rulesViewer.show();
	}



	// Load a folder containing a set of schema package files from disk into the editor and into ensemble.
	var loadPackage = function() {
		var chooser = document.querySelector('#fileDialog');

		// The "change" event is triggered from the querySelector when the user has selected a file object (in this case, restricted to a folder by the "nwdirectory" flag in the #fileDialog item in ensembleconsole.html) and confirmed their selection by clicking OK.
		chooser.addEventListener("change", function(evt) {
			resetTool();
			var pkg;
			try {
				pkg = fileio.loadSchemaFromFolder(this.value, function(pkg) {
					loadSchema(pkg.schema);
					if (pkg.cast) {
						loadCast(pkg.cast);
					}
					if (pkg.history) {
						loadHistory(pkg.history);
					}
					if (pkg.rules) {
						// Should be an array of contents of rules files.
						pkg.rules.forEach(function(ruleObj) {
							loadRules(ruleObj);
						});
					}
					if (pkg.actions) {
						loadActions(pkg.actions);
					}
					rulesEditor.init(rulesViewer, ruleOriginsTrigger, ruleOriginsVolition, saveRules);
					updateConsole();
					consoleViewer.cmdLog("Schema loaded.", true);
				});
			} catch(e) {
				console.trace();
				consoleViewer.cmdLog(e);
				return;
			}

		}, false);
		chooser.click();  

	};



	// ****************************************************************
	// INIT / REGISTRATION
	// ****************************************************************


	// Take a schema definition object, register it with ensemble, and display its details in the UI.
	var loadSchema = function(schema) {

		try {
			socialStructure = ensemble.loadSocialStructure(schema);	
		} catch(e) {
			messages.showError(e);
			return;
		}

		// Generate explanatory text.
		var exp = "";
		for (var categoryName in socialStructure) {
			var d = ensemble.getCategoryDescriptors(categoryName);
			var direction = d.directionType;
			var dataType = d.isBoolean ? "boolean" : "numeric";
			var duration = d.duration > 0 ? "duration " + d.duration : "";
			if (!d.isBoolean) {
				dataType += " " + d.min + "-->" + d.max + " (default " + d.defaultVal + ")";
			}
			if (d.duration === 0) {
				duration = "single turn";
			}
			exp += "<p class='schemaHeader'><span class='categoryName'>" + categoryName + "</span> <span class='categoryInfo'>" + direction + ", " + dataType + (duration !== "" ? ", " + duration : "") + "</span></p>";
			var c = socialStructure[categoryName];
			exp += "<p class='schemaTypes'>";
			var types = [];
			for (var typeName in c) {
				types.push("<span class='schemaType'>" + typeName + "</span>");
			}
			var typeList = types.join(" &bull; ");
			exp += typeList + "<br/>"
		}

		$("#infoOnSocialTypes").html(exp);
	};


	// Take a cast definition object, register it with ensemble and store it locally, and display its details in the UI.
	var loadCast = function(cast) {

		characters = ensemble.addCharacters(cast);
		fullCharacters = ensemble.getCharactersWithMetadata();

		// Generate labels
		var txt = "<ul>";
		for (var charPos in characters) {
			txt += "<li>" + fullCharacters[characters[charPos]].name + "</li>"
		}
		txt += "</ul>";

		$("#characterList").html(txt);

	};


	// Take a history definition object, and load it into ensemble.
	var loadHistory = function(content) {
		var history = content.history;
		var lastPos = -9999999999;
		for (var i = 0; i < history.length; i++) {
			// TODO add more error checking to look for out-of-order history steps, etc.
			var historyAtTime = history[i];
			if (historyAtTime.pos <= lastPos) {
				messages.showError("Tried to load a history file but timeStep " + historyAtTime.pos + " came after timeStep " + lastPos + "; history files must declare timesteps sequentially.");
				return;
			}
			lastPos = historyAtTime.pos;
			ensemble.setupNextTimeStep(historyAtTime.pos);
			for (var j = 0; j < historyAtTime.data.length; j++) {
				var pred = historyAtTime.data[j];
				try {
					ensemble.set(pred);
				} catch(e) {
					messages.showError("invalid history file! double check  predicate on console");
					console.log("invalid predicate in history:", pred);
					return;
				}
			}
		}
	};


	// Take a rules definition object, load it into ensemble, and display it in the appropriate UI tab.
	var loadRules = function(rules) {
		ensemble.addRules(rules);
		if (rules.type === "trigger") {
			ruleOriginsTrigger.push(rules.fileName);
			rulesViewer.show("trigger");
		}
		if (rules.type === "volition") {
			ruleOriginsVolition.push(rules.fileName);
			rulesViewer.show("volition");
		}
	};


	// Take an action definition object, load it into ensemble, and display in UI.
	var loadActions = function(actions){
		actionLibrary.parseActions(actions);
		var myActions = actionLibrary.getTerminalActions();
		// Generate labels
		var txt = "<ul>";
		for (var actionPos in myActions) {
		// Can be replaced with something more complex later
			txt += "<li>" + myActions[actionPos].name + "</li>";
		}
		txt += "</ul>";
		$("#actionList").html(txt);
	};

	ensemble.init();
	fileio.init();
	rulesViewer.init();

	if (autoLoad === false && fs === undefined) {
		autoLoad = true; // let's have it use autoload when using the webpage version of the console.
	}

	if (autoLoad) {
		loadSchema(JSON.parse(sampleData));
		loadRules(JSON.parse(testVolitionRules));
		loadRules(JSON.parse(testTriggerRules));
		loadHistory(JSON.parse(testSfdbData));
		loadCast(JSON.parse(sampleChars));
		loadActions(JSON.parse(testActions));
		rulesEditor.init(rulesViewer, ruleOriginsTrigger, ruleOriginsVolition, saveRules);
		consoleViewer.cmdLog("Autoloaded default schema.", true);
	}
	else{
		//ask the user to specify a schema.
		// loadPackage();
	}

	consoleViewer.init();
	updateConsole();

	// Handle a keypress on the rule filter text box, forwarding to the function within rulesViewer that filters the view accordingly.
	var ruleFilterKey = function(e) {
		var raw = document.getElementById("inputRuleFilter").value;
		rulesViewer.filterWithout("tabstrigger", raw);
		rulesViewer.filterWithout("tabsvolition", raw);
	}

	document.getElementById("inputRuleFilter").onkeyup = ruleFilterKey;
	document.getElementById("inputRuleFilter").onchange = ruleFilterKey;

});