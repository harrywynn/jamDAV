# jamDAV

jamDAV pulls events from your [Jam Family Calendar](https://jamfamilycalendar.com) so you can feed them into a calDAV server and access them from other calendar applications.  Tested and working with [Radicale](https://radicale.org/v3.html).

## Requirements
jamDAV requires Node v20.x and that's about it.

## Configuration
Create an ```.env``` file in the root of the project with the following values:

```ICS_PATH``` - full path to where the .ics files should be created  
```CLIENT_SECRET``` - see step #6 below  
```CLIENT_ID``` - see step #7 below  

You'll need to obtain some additional values from the sign in request on the web:

1. Log out of your account if signed in  
2. Open Chrome developer tools and click the **Network** tab  
3. Sign in to your account  
4. Filter the URLs with ```sign-in``` and select the request  
5. From the **Reponse** tab save the value for ```refresh_token``` to a file named ```token.txt``` in the root of the project directory
6. From the **Headers** tab save the value for ```Client_secret``` to ```CLIENT_SECRET``` in ```.env```
7. From the **Headers** tab save the value for ```Client_id``` to ```CLIENT_ID``` in ```.env```

## Running
```npm run jam```



