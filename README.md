# ByBit-TradeManager-Using-AWS-Lambda
An AWS lambda function I wrote to manage a complex trading algorithm based on NNFX trading principles. The lambda function and ByBit API wrapper functions have all been merged into a single manageTrade.js file.

The process basically works as follows: 

 - Setting up a chart on TradingView with the required indicators on it and send those indicator values to the AWS Lambda function on every candle close (I used API Gateway to set up endpoints) 
- The data is then stored inside a DynamoDB table because each time new values came in we need to compare them to the old values 
- After storing the data, one of the trading algorithm functions is run based upon what the current state of the trade is (this is also stored in the DB) 
- Finally, the function communicates with ByBit using one of the functions from a ByBit API wrapper I wrote myself to manage the trade on ByBit

Unfortunately, inconsistencies with ByBit's API made this project exceptionally difficult. I even went to the lengths of using cron jobs via Cloudwatch Events to check on DB values and re-run functions when necessary if ByBit wasn't cooperating, and ultimately gave up on it. Apart from this, it all ran well and the algorithm produced positive returns of about 8% over the course of a month.
