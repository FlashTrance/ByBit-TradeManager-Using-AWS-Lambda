// NAME: manageTrade
// AUTHOR: Rohan Mital (FlashTrance)

// DESCRIPTION: Manages ByBit trades based on TradingView indicator values sent to API Gateway via Alerts. Uses
// DynamoDB to store updated indicator and trade-related data on each candle close and ByBit API to communicate with 
// ByBit. Rules for entry, exit, risk management, etc. are based on NNFX trading principles, but have been modified 
// to suit my algorithm.

// NOTES: Lambda concurrency is set to 1; four TradingView Alerts come in at once on each bar close, so we need to
// wait for the last one to be processed to ensure all our data is up to date before proceeding.

const aws = require("aws-sdk");
const dynamoDB = new aws.DynamoDB.DocumentClient();
const secrets = new aws.SecretsManager();
const crypto = require("crypto");
const https = require("https");

var old_indicator_values = {};
var cur_indicator_values = {};
var creds = {"KEY":"", "SECRET":""};
var symbol = "";
var TRADE_STATE = "";
var TRADE_INFO = {}; // New trade info to add to DB, if we enter a trade

const BASE_URL = "https://api-testnet.bybit.com";
//const BASE_URL = "https://api.bybit.com";
const SECRET_NAME = "creds/bybit";
const USE_TESTNET = true;
const QTY_PERCENT = 0.1; // How much of our total balance to put in trade


// MAIN //
exports.handler = async(event, context) => 
{
    // Manage trade after all TradingView requests have been processed
    if (await processAPIInput(event["body"]))
    {
        // Retrieve API Secrets for exchange
        if (await getSecrets(SECRET_NAME) && creds["KEY"].length > 1)
        {
            TRADE_STATE = cur_indicator_values["TRADE_STATE"];
            var position_info = await getPositionInfo(symbol);
            console.log(position_info);
            console.log("Trying to parse position_info...");
            position_info = JSON.parse(position_info);
            position_info = position_info["result"];
            
            // POSITION OPEN
            if (position_info["size"] > 0)
            {
                console.log("IN POSITION...");
                switch (TRADE_STATE) 
                {
                    case "IN_LONG":
                    case "IN_SHORT":
                    case "IN_LONG_TP1":
                    case "IN_SHORT_TP1":
                        const trade_res = inTradeRules();
                        if (trade_res == "FRESH" || trade_res == "LOST_TO_BASELINE") { closeOpenOrder(); TRADE_STATE = trade_res; }
                        break;
   
                  default:
                    console.error("Default case triggered while IN POSITION! Trade State: " + TRADE_STATE);
                }
            }
            
            // NO POSITION OPEN
            else
            {
                var successful = false; // Used to ensure TPs are set successfully
                
                console.log("NOT IN POSITION...");
                switch (TRADE_STATE) 
                {
                    // REGULAR ENTRY
                    case "FRESH":
                    case "ATR_LONG":
                    case "ATR_SHORT":
                    case "ATR_LONG_1":
                    case "ATR_SHORT_1":
                        console.log("ENTRY RULES...");
                        const entry_res = entryRules();
                        if (entry_res == "IN_LONG" || entry_res == "IN_SHORT") 
                        { 
                            await placeMarketOrder(entry_res); 
                            successful = await setTPs(entry_res);
                            if (!successful) { closeOpenOrder(); console.error("Failed to place TP and SL, open order cancelled"); }
                        }
                        else if (entry_res != false) { TRADE_STATE = entry_res; }
                        
                        break;
                        
                    // CONTINUATION TRADE
                    case "CONTINUATION":
                        console.log("CONTINUATION...");
                        const continuation_res = continuationRules();
                        if (continuation_res == "IN_LONG" || continuation_res == "IN_SHORT") 
                        { 
                            await placeMarketOrder(continuation_res); 
                            successful = await setTPs(continuation_res);
                            if (!successful) { closeOpenOrder(); console.error("Failed to place TP and SL, open order cancelled"); }
                        }
                        else if (continuation_res != false) { TRADE_STATE = continuation_res; }
                        
                        break;
                        
                    // LOST TO BASELINE RULES
                    case "LOST_TO_BASELINE":
                        console.log("LOST TO BASELINE...");
                        const lost_to_basel_res = lostToBaseline();
                        if (lost_to_basel_res == "FRESH")
                        {
                            TRADE_STATE = "FRESH";
                            const entry_res = entryRules();
                            if (entry_res == "IN_LONG" || entry_res == "IN_SHORT") 
                            { 
                                await placeMarketOrder(entry_res); 
                                successful = await setTPs(entry_res);
                                if (!successful) { closeOpenOrder(); console.error("Failed to place TP and SL, open order cancelled"); }
                            }
                            else if (entry_res != false) { TRADE_STATE = entry_res; }
                        }
                        break;
                    
                    // TRIGGERED TP OR SL
                    case "IN_LONG":
                    case "IN_SHORT":
                    case "IN_LONG_TP1":
                    case "IN_SHORT_TP1":
                        console.log("TRIGGERED TP/SL...");
                        const closed_res = positionClosed();
                        
                        TRADE_STATE = closed_res;
                        switch (TRADE_STATE)
                        {
                            case "FRESH":
                                const entry_res = entryRules();
                                if (entry_res == "IN_LONG" || entry_res == "IN_SHORT") 
                                { 
                                    await placeMarketOrder(entry_res); 
                                    successful = await setTPs(entry_res);
                                    if (!successful) { closeOpenOrder(); console.error("Failed to place TP and SL, open order cancelled"); }
                                }
                                else if (entry_res != false) { TRADE_STATE = entry_res; }
                                break;
                            case "CONTINUATION":
                                const continuation_res = continuationRules();
                                if (continuation_res == "IN_LONG" || continuation_res == "IN_SHORT") 
                                { 
                                    await placeMarketOrder(continuation_res); 
                                    successful = await setTPs(continuation_res);
                                    if (!successful) { closeOpenOrder(); console.error("Failed to place TP and SL, open order cancelled"); }
                                }
                                else if (continuation_res != false) { TRADE_STATE = continuation_res; }
                                break;
                            case "LOST_TO_BASELINE":
                                TRADE_STATE = "LOST_TO_BASELINE"; // We just hit our SL, need to wait for new flip, no chance of new trade here
                            default:
                        }
                        break;
                    
                    default:
                        console.error("Default case triggered while NOT IN POSITION! Trade State: " + TRADE_STATE);
                }
            }
            
            // End of trade management - Housekeeping
            await executionComplete();
        }
        else { console.error("Failed to retrieve creds from Secrets Manager"); }
    }
    
    return context.logStreamName;
};


// processAPIInput()
// Process data we received from TradingView Alerts, update Dynamo DB table, and verify whether we've received 
// all requests from TradingView
const processAPIInput = async(api_input) =>
{
    console.log("processAPIInput() start...");
    
    //const tradingview_json = JSON.parse(api_input);
    const tradingview_json = api_input; // For testing in AWS console
    symbol = tradingview_json["PAIR"];
    
    // Get the current values in DB so we can compare later
    old_indicator_values = await getDBItems();
    if (old_indicator_values != false)
    {
        // Params for DB Get
        const db_params_get = {
            TableName: "IndicatorData",
            Key: { "PAIR": symbol }
        };
        
        // Setup params for DB Update
        const keys = Object.keys(tradingview_json);
        var updateExpession = "set ";
        var updateValues = {};
        keys.forEach( (key) => 
        {
            if (key != "PAIR") 
            { 
                updateExpession += key.toString() + " = :" + key + ", "; 
                updateValues[":" + key] = tradingview_json[key];
            }
        });
        updateExpession = updateExpession.substr(0, updateExpession.length-2);
        
        // Params for DB Update
        const db_params_update = {
            TableName: "IndicatorData",
            Key: { "PAIR": symbol },
            UpdateExpression: updateExpession,
            ExpressionAttributeValues: updateValues
        }
        
        // Update DB and check timestamps to see if they're all synced
        return new Promise( (resolve, reject) =>
        {
            dynamoDB.update(db_params_update, (err, data) =>
            {
                if (!err) 
                { 
                    dynamoDB.get(db_params_get, (err, data) => 
                    {
                        if (!err)
                        {
                            const db_res = data["Item"];
                            const ts_hours = [
                                db_res["BASELINE_TIMESTAMP"].slice(14,16),  // 11 and 12 = hour, 14 and 16 = minute
                                db_res["C1_TIMESTAMP"].slice(14,16),
                                db_res["VOL_TIMESTAMP"].slice(14,16),
                                db_res["ATR_TIMESTAMP"].slice(14,16)
                            ]
                            if (!ts_hours.includes(db_res["LAST_SUCCESSFUL_EXECUTION"])) // This makes it so only the last lambda to run executes all the way through
                            {
                                const set_hours = new Set(ts_hours);
                            
                                if (set_hours.size == 1) 
                                { 
                                    console.log("processAPIInput() successful...");
                                    cur_indicator_values = db_res;
                                    resolve(true); 
                                }
                                else { console.log("Timestamps not synced yet..."); console.log(set_hours); resolve(false); }
                            }
                            else { console.log("Execution already completed for hour: " + db_res["LAST_SUCCESSFUL_EXECUTION"]); resolve(false); }
                        }
                        else { console.error(err); reject(false); }
                    });
                }
                else { console.error(err); reject(false); }
            });
        });
    }
};


// getDBItems()
// Retrieve the current item values in the database
const getDBItems = async () =>
{
    const db_params_get = {
        TableName: "IndicatorData",
        Key: { "PAIR": symbol }
    };
    
    return new Promise( (resolve, reject) =>
    {
        dynamoDB.get(db_params_get, (err, data) => 
        {
            if (!err) { resolve(data["Item"]); }
            else { console.error(err); reject(false); }
        });
    });
};


// getSecrets()
// Retrieve Secret values from SecretsManager
const getSecrets = async (secret_id) =>
{
    console.log("getSecrets() start...");
    return new Promise( (resolve, reject) => {
        secrets.getSecretValue({SecretId: secret_id}, (err, data) => 
        {
            if (!err && "SecretString" in data) 
            { 
                data = JSON.parse(data["SecretString"]);
                if (USE_TESTNET) 
                { 
                    creds["KEY"] = data["TESTNET_API_KEY"]; 
                    creds["SECRET"] = data["TESTNET_API_SECRET"]; 
                }
                else
                {
                    creds["KEY"] = data["API_KEY"]; 
                    creds["SECRET"] = data["API_SECRET"]; 
                }
                console.log("getSecrets() successful...");
                resolve(true); 
            }
            else { console.error(err); reject(false); }
        });
    });
};


// executionComplete()
// Some final DB updates (hour of latest execution, new trade info, order details, etc.) after a successful execution 
const executionComplete = async () =>
{
    console.log("Finished! Final TRADE_STATE: " + TRADE_STATE + ", Final TIME: " + cur_indicator_values["BASELINE_TIMESTAMP"]);
    var updateExpession = "set LAST_SUCCESSFUL_EXECUTION = :last_execution_hour, TRADE_STATE = :trade_state";
    var updateValues = { 
        ":last_execution_hour": cur_indicator_values["BASELINE_TIMESTAMP"].slice(14,16),
        ":trade_state": TRADE_STATE
    };
    
    // Check if we have a new trade to enter into DB
    const keys = Object.keys(TRADE_INFO);
    if (keys.length > 0)
    {
        keys.forEach( (key) => 
        {
            updateExpession += key.toString() + " = :" + key + ", "; 
            updateValues[":" + key] = TRADE_INFO[key];
        });
        updateExpession = updateExpession.substr(0, updateExpession.length-2);
    }

    // Params for DB Update
    const db_params_update = {
        TableName: "IndicatorData",
        Key: { "PAIR": symbol },
        UpdateExpression: updateExpession,
        ExpressionAttributeValues: updateValues
    }
    
    // Update DB
    return new Promise( (resolve, reject) =>
    {
        dynamoDB.update(db_params_update, (err, data) =>
        {
            if (err) { console.error(err); reject(false); }
            else     { console.log("executionComplete() finished successfully"); resolve(true); }
        });
    });
};



////////////////
/* ALGO RULES */
////////////////

// entryRules()
// Rules for a regular Entry
const entryRules = () =>
{
    // C1 Side
    var SIDE = "";
    if (cur_indicator_values["C1_LONG_VALUE"] > cur_indicator_values["C1_SHORT_VALUE"])      { SIDE = "IN_LONG"; }
    else if (cur_indicator_values["C1_LONG_VALUE"] < cur_indicator_values["C1_SHORT_VALUE"]) { SIDE = "IN_SHORT"; }
    
    if (SIDE == "IN_LONG")
    {
        console.log("SIDE LONG");
        if (cur_indicator_values["CANDLE_CLOSE"] <= cur_indicator_values["BASELINE_VALUE"])    { console.log("Baseline Fail"); return false; } // Baseline
        if (cur_indicator_values["VOL_LONG_VALUE"] <= cur_indicator_values["VOL_SHORT_VALUE"]) { console.log("Vol Fail"); return false; } // Volume MA
        
        // ATR
        if (TRADE_STATE.includes("SHORT")) { return "FRESH"; } // Not likely, C1 would have to flip bullish right after an ATR_SHORT...
        if (cur_indicator_values["CANDLE_CLOSE"] >= cur_indicator_values["BASELINE_VALUE"] + cur_indicator_values["ATR_VALUE"]) 
        { 
            console.log("ATR Fail");
            if (TRADE_STATE == "FRESH")         
            { 
                console.log("ATR FRESH");
                // We enforce the Pullback rule if we got a single candle that closed beyond the ATR value
                if (old_indicator_values["CANDLE_CLOSE"] < old_indicator_values["BASELINE_VALUE"]) { console.log("ATR LONG"); return "ATR_LONG"; }
                else { return false; }
            }
            else if (TRADE_STATE == "ATR_LONG") { console.log("ATR LONG 1"); return "ATR_LONG_1"; }
            else                                { return "FRESH"; }
        }
        
        return SIDE;
    }
    
    else if (SIDE == "IN_SHORT")
    {
        console.log("SIDE SHORT");
        if (cur_indicator_values["CANDLE_CLOSE"] >= cur_indicator_values["BASELINE_VALUE"])    { console.log("Baseline Fail"); return false; } // Baseline
        if (cur_indicator_values["VOL_LONG_VALUE"] >= cur_indicator_values["VOL_SHORT_VALUE"]) { console.log("Vol Fail"); return false; } // Volume MA
        
        // ATR
        if (TRADE_STATE.includes("LONG")) { return "FRESH"; }
        if (cur_indicator_values["CANDLE_CLOSE"] <= cur_indicator_values["BASELINE_VALUE"] - cur_indicator_values["ATR_VALUE"]) 
        { 
            console.log("ATR Fail");
            if (TRADE_STATE == "FRESH")         
            { 
                console.log("ATR FRESH");
                // We enforce the Pullback rule if we got a single candle that closed beyond the ATR value
                if (old_indicator_values["CANDLE_CLOSE"] > old_indicator_values["BASELINE_VALUE"]) { console.log("ATR SHORT"); return "ATR_SHORT"; }
                else { return false; }
            }
            else if (TRADE_STATE == "ATR_SHORT") { console.log("ATR SHORT 1"); return "ATR_SHORT_1"; }
            else                                 { return "FRESH"; }
        }
        
        return SIDE;
    }
    
    return false;
};


// inTradeRules()
// Handling when we're currently in an active trade
const inTradeRules = () =>
{
    console.log("inTradeRules() start...");
    if (TRADE_STATE == "IN_LONG")
    {
        // Baseline Cross opposite our position side (Market Close)
        if (cur_indicator_values["CANDLE_CLOSE"] < cur_indicator_values["BASELINE_VALUE"]) 
        {
            if (cur_indicator_values["CANDLE_HIGH"] >= cur_indicator_values["TRADE_TP1"]) { return "FRESH"; }
            else { return "LOST_TO_BASELINE"; } 
        }
        else if (cur_indicator_values["CANDLE_HIGH"] >= cur_indicator_values["TRADE_TP1"]) { return "IN_LONG_TP1"; } // Hit TP1
        else if (cur_indicator_values["C1_SHORT_VALUE"] > cur_indicator_values["C1_LONG_VALUE"]) { return "FRESH"; } // C1 Flip
    }
    
    else if (TRADE_STATE == "IN_SHORT")
    {
        // Baseline Cross opposite our position side (Market Close)
        if (cur_indicator_values["CANDLE_CLOSE"] > cur_indicator_values["BASELINE_VALUE"]) 
        {
            if (cur_indicator_values["CANDLE_LOW"] <= cur_indicator_values["TRADE_TP1"]) { return "FRESH"; }
            else { return "LOST_TO_BASELINE"; } 
        }
        else if (cur_indicator_values["CANDLE_LOW"] <= cur_indicator_values["TRADE_TP1"]) { return "IN_SHORT_TP1"; } // Hit TP1
        else if (cur_indicator_values["C1_LONG_VALUE"] > cur_indicator_values["C1_SHORT_VALUE"]) { return "FRESH"; } // C1 Flip
    }
    
    else if (TRADE_STATE == "IN_LONG_TP1")
    {
        // Theoretically, this should never happen, but just in case...
        if (cur_indicator_values["CANDLE_CLOSE"] < cur_indicator_values["TRADE_ENTRY"]) { return "FRESH"; }
    }
    
    else if (TRADE_STATE == "IN_SHORT_TP1")
    {
        if (cur_indicator_values["CANDLE_CLOSE"] > cur_indicator_values["TRADE_ENTRY"]) { return "FRESH"; }
    }

    else { return "FRESH"; }
};


// continuationRules()
// Rules for a continuation trade
const continuationRules = () =>
{
    // C1 Side
    var SIDE = "";
    if (cur_indicator_values["C1_LONG_VALUE"] > cur_indicator_values["C1_SHORT_VALUE"])      { SIDE = "IN_LONG"; }
    else if (cur_indicator_values["C1_LONG_VALUE"] < cur_indicator_values["C1_SHORT_VALUE"]) { SIDE = "IN_SHORT"; }
    
    if (SIDE == "IN_LONG")
    {
        if (cur_indicator_values["CANDLE_CLOSE"] <= cur_indicator_values["BASELINE_VALUE"])    { return "FRESH"; } // Baseline
        if (cur_indicator_values["VOL_LONG_VALUE"] <= cur_indicator_values["VOL_SHORT_VALUE"]) { return false; }   // Volume MA
        if (cur_indicator_values["CANDLE_CLOSE"] >= cur_indicator_values["BASELINE_VALUE"] + cur_indicator_values["ATR_VALUE"]) { return false; } // ATR
        
        return SIDE;
    }
    
    else if (SIDE == "IN_SHORT")
    {
        if (cur_indicator_values["CANDLE_CLOSE"] >= cur_indicator_values["BASELINE_VALUE"])    { return "FRESH"; } // Baseline
        if (cur_indicator_values["VOL_LONG_VALUE"] >= cur_indicator_values["VOL_SHORT_VALUE"]) { return false; }   // Volume MA
        if (cur_indicator_values["CANDLE_CLOSE"] <= cur_indicator_values["BASELINE_VALUE"] - cur_indicator_values["ATR_VALUE"]) { return false; } // ATR
        
        return SIDE;
    }
    
    return false;
};


// positionClosed()
// Respond to our position being recently closed (by TP or SL)
const positionClosed = () =>
{
    if (TRADE_STATE == "IN_LONG" || TRADE_STATE == "IN_LONG_TP1")
    {
        // Closed by TP
        if (cur_indicator_values["CANDLE_HIGH"] >= cur_indicator_values["TRADE_TP3X"] && cur_indicator_values["CANDLE_LOW"] > cur_indicator_values["TRADE_SL"])
        {
            if (cur_indicator_values["CANDLE_CLOSE"] > cur_indicator_values["BASELINE_VALUE"]) { return "CONTINUATION"; } // Candle closed above Baseline (Long)
            else                                                                               { return "FRESH"; }        // Candle closed below Baseline (Long)
        }
    }
    
    else
    {
        // Closed by TP
        if (cur_indicator_values["CANDLE_LOW"] <= cur_indicator_values["TRADE_TP3X"] && cur_indicator_values["CANDLE_HIGH"] < cur_indicator_values["TRADE_SL"])
        {
            if (cur_indicator_values["CANDLE_CLOSE"] < cur_indicator_values["BASELINE_VALUE"]) { return "CONTINUATION"; } // Candle closed below Baseline (Short)
            else                                                                               { return "FRESH"; }        // Candle closed above Baseline (Short)
        }
    }
    
    return "LOST_TO_BASELINE"; // Closed by SL
};


// lostToBaseline()
// Rules when we're in a LOST_TO_BASELINE state
const lostToBaseline = () =>
{
    // When we lose the last trade due to a Baseline Cross, we MUST wait for either a C1 flip or a Volume cross before
    // we can enter a new trade. This is to help reduce back-to-back losses during consolidations.

    // C1 Cross
    if ( (old_indicator_values["C1_LONG_VALUE"] > old_indicator_values["C1_SHORT_VALUE"] && cur_indicator_values["C1_LONG_VALUE"] < cur_indicator_values["C1_SHORT_VALUE"])
        || 
        (old_indicator_values["C1_LONG_VALUE"] < old_indicator_values["C1_SHORT_VALUE"] && cur_indicator_values["C1_LONG_VALUE"] > cur_indicator_values["C1_SHORT_VALUE"]) ) 
        { return "FRESH"; }

    // Volume Cross
    else if ( (old_indicator_values["VOL_LONG_VALUE"] > old_indicator_values["VOL_SHORT_VALUE"] && cur_indicator_values["VOL_LONG_VALUE"] < cur_indicator_values["VOL_SHORT_VALUE"]) 
            ||
            (old_indicator_values["VOL_LONG_VALUE"] < old_indicator_values["VOL_SHORT_VALUE"] && cur_indicator_values["VOL_LONG_VALUE"] > cur_indicator_values["VOL_SHORT_VALUE"]) )
            { return "FRESH"; }
            
    return false;
};



///////////////
/* BYBIT API */
///////////////

// placeMarketOrder()
// Place a Market order on Bybit
const placeMarketOrder = async (side) => 
{
    console.log("placeMarketOrder() start...");
    var stop_loss = 0.0;
    var qty = 0;
    var bybit_side = "Buy";
    if (side == "IN_SHORT") 
    { 
        bybit_side = "Sell"; 
        stop_loss = cur_indicator_values["CANDLE_CLOSE"] - (cur_indicator_values["ATR_VALUE"] * 1.5);
    }
    else { stop_loss = cur_indicator_values["CANDLE_CLOSE"] + (cur_indicator_values["ATR_VALUE"] * 1.5); } 
    
    // Determine qty value
    var balance = 0.0;
    balance = await getBalance(symbol.slice(0,3));
    if (balance > 1)
    {
        qty = Math.floor(balance * QTY_PERCENT); // "qty" must be an integer
        
        // Setup request parameters (TP values are setup after placing order)
        var order_params = {};
        order_params = 
        {
            "api_key": creds["KEY"],
            "order_type": "Market",
            "qty": qty,
            "stop_loss": stop_loss,
            "symbol": symbol,
            "side": bybit_side,
            "time_in_force": "GoodTillCancel"
        };
        
        // Setup POST Request
        const options = {
          hostname: "api-testnet.bybit.com",
          port: 443,
          path: "/v2/private/order/create",
          method: "POST",
          headers: {"Content-Type": "application/json"}
        };
        
        // Get signature for authenticated request
        order_params["timestamp"] = Date.now() + 800; // Server is expecting TS to be < server_time + 1000
        order_params["sign"] = getSignature(order_params, creds["SECRET"]);
        order_params = JSON.stringify(order_params);
        
        return new Promise( (resolve, reject) => 
        {
            // Send POST Request
            const req = https.request(options, (res) => {
                console.log("ByBit placeMarketOrder() RES CODE: " + res.statusCode);
            });
            
            req.on("error", (err) => { console.error(err); reject(false); });
            req.write(order_params);
            
            // Update trade info in DB after request completes successfully
            req.end( () => {
                TRADE_STATE = side;
                TRADE_INFO["TRADE_SL"] = stop_loss;
                TRADE_INFO["TRADE_ENTRY"] = cur_indicator_values["CANDLE_CLOSE"];
                TRADE_INFO["ORDER_QTY"] = qty; // Used in closeOpenOrder() if needed
                
                console.log("placeMarketOrder() successful...");
                resolve(true);
            });
        }); 
    }
    
    else { TRADE_STATE = "FRESH"; console.error("Could not place order due to 0 balance"); }
};


// closeOpenOrder()
// Immediately closes an open position using a Market order
const closeOpenOrder = async () =>
{
    var qty = cur_indicator_values["ORDER_QTY"];
    var side = "Buy";
    if ("ORDER_QTY" in TRADE_INFO) { qty = TRADE_INFO["ORDER_QTY"]; }
    if (cur_indicator_values["TRADE_STATUS"].includes("LONG")) { side = "Sell"; }
    
    // Setup request parameters (TP values are setup after placing order)
    var order_params = {};
    order_params = 
    {
        "api_key": creds["KEY"],
        "order_type": "Market",
        "qty": qty,
        "symbol": symbol,
        "side": side,
        "time_in_force": "GoodTillCancel"
    };
    
    // Setup POST Request
    const options = {
      hostname: BASE_URL,
      port: 443,
      path: "/v2/private/order/create",
      method: "POST",
    };
    
    // Get signature for authenticated request
    order_params["timestamp"] = Date.now() + 800; // Server is expecting TS to be < server_time + 1000
    order_params["sign"] = getSignature(order_params, creds["SECRET"]);
    order_params = JSON.stringify(order_params);
    
    return new Promise( (resolve, reject) => 
    {
        // Send POST Request
        const req = https.request(options, (res) => {
            console.log("ByBit placeMarketOrder() RES CODE: " + res.statusCode);
        });
        
        req.on("error", (err) => { console.error(err); reject(false); });
        req.write(order_params)
        
        // Update trade info in DB after request completes successfully
        req.end( () => 
        {
            TRADE_STATE = "FRESH";
            resolve(true);
        });
    }); 
};


// setTPs()
// Set TPs for open position (SL should already be set when placing order)
const setTPs = () =>
{
    console.log("setTPs() start...");
    
    // Calculate TPs based on algo rules
    const TP1 = cur_indicator_values["CANDLE_CLOSE"] + cur_indicator_values["ATR_VALUE"];
    const TP3X = cur_indicator_values["CANDLE_CLOSE"] + (cur_indicator_values["ATR_VALUE"] * 3.0); 
    var take_profit = TP1;
    
    // Calculate TP size
    var order_qty = TRADE_INFO["ORDER_QTY"];
    var tp_size = Math.floor(order_qty / 2); 
    var uneven_tp = false;
    if (order_qty % 2 !== 0) { uneven_tp = true; } // If TPs don't divide
    
    // Setup request parameters (TP and SL are setup after placing order)
    var order_params = {};
    order_params = 
    {
        "api_key": creds["KEY"],
        "symbol": symbol,
    };
    
    // We need two TPs, so we run this twice
    for (var i = 0; i++; i < 2)
    {
        if (i === 1) 
        { 
            take_profit = TP3X; 
            if (uneven_tp) { tp_size += 1; }
        }
        order_params["take_profit"] = take_profit;
        order_params["tp_size"] = tp_size;
        
        // Setup POST Request
        const options = {
          hostname: BASE_URL,
          port: 443,
          path: "/v2/private/order/create",
          method: "POST",
        };
    
        // Get signature for authenticated request
        order_params["timestamp"] = Date.now() + 800; // Server is expecting TS to be < server_time + 1000
        order_params["sign"] = getSignature(order_params, creds["SECRET"]);
        order_params = JSON.stringify(order_params);
        
        return new Promise( (resolve, reject) => 
        {
            // Send POST Request
            const req = https.request(options, (res) => {
                console.log("ByBit setTPs() RES CODE: " + res.statusCode);
            });
            
            req.on("error", (err) => { console.error(err); reject(false); });
            req.write(order_params)
            
            // Update trade info in DB after request completes successfully
            req.end( () => 
            {
                if (i === 0) { TRADE_INFO["TRADE_TP1"] = TP1; }
                else         { TRADE_INFO["TRADE_TP3X"] = TP3X; }
                
                console.log("setTPs() successful...");
                resolve(true);
            });
        }); 
    }
};


// getPositionInfo()
// Return info on our positions
const getPositionInfo = async (pair) =>
{
    console.log("getPositionInfo() start...");
    // Setup request parameters
    var order_params = {};
    order_params = 
    {
        "api_key": creds["KEY"],
        "symbol": pair
    };
    const url = createURL(order_params, "/v2/private/position/list");
    
    return new Promise ( (resolve, reject) => 
    {
        // Send GET Request
        https.get(url, (res) => {
            var data = "";
            
            // Retrieve all chunks of data
            res.on("data", (chunk) => {
                data += chunk;
            });
            
            // All data received
            res.on("end", () => {
                console.log("getPositionInfo() successful...");
                resolve(data);
            });
            
        }).on("error", (err) => { reject(err.message); });
    });
};


// getBalance()
// Retrieve wallet balance for given symbol
const getBalance = async (coin) =>
{
    // Setup request parameters
    var order_params = {};
    order_params = 
    {
        "api_key": creds["KEY"],
        "coin": coin
    };
    const url = createURL(order_params, "/v2/private/wallet/balance");
    
    // Wrap GET in a Promise so we can respond to the resolved value
    return new Promise( (resolve, reject) => 
    {
        // Send GET Request
        https.get(url, (res) => {
            var data = "";
            
            // Retrieve all chunks of data
            res.on("data", (chunk) => {
                data += chunk;
            });
            
            // All data received
            res.on("end", () => {
                data = JSON.parse(data);
                const coin_balance = data["result"][coin]["wallet_balance"];
                resolve(coin_balance * cur_indicator_values["CANDLE_CLOSE"]); // Convert to USD
            });
            
        }).on("error", (err) => { reject(err.message); });
    });
};


// createURL()
// Creates a URL for use in https module request using provided parameters
const createURL = (order_params, endpoint) => 
{
    var url = BASE_URL + endpoint + "?";
    for (var key in order_params) {
        url += key + "=" + order_params[key] + "&";
    }

    // Get signature for authenticated request
    order_params["timestamp"] = Date.now() + 800; // Server is expecting TS to be < server_time + 1000
    order_params["sign"] = getSignature(order_params, creds["SECRET"]);
    url += "timestamp=" + order_params["timestamp"] + "&sign=" + order_params["sign"];
    
    return url;
};


// getSignature() 
// Generates a signature using request params for use in private API calls
const getSignature = (parameters, secret) =>
{
    // Order parameters alphabetically
	var orderedParams = "";
    Object.keys(parameters).sort().forEach(function(key) { orderedParams += key + "=" + parameters[key] + "&"; });
    orderedParams = orderedParams.substring(0, orderedParams.length - 1);

    // Generate signature
	return crypto.createHmac("sha256", secret).update(orderedParams).digest("hex");
};
