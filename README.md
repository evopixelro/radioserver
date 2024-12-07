# Radio Server
A shoutcast radio server with autodj.

## How to install
- Install lib32stdc++6
- Copy git files on your Linux user
- Give to radioserver file the 777 permission
- Config the sc_serv.conf and sc_trans.conf file
- Start the radio server by using command `./radioserver start`
- Take a look on playlist.txt file
- Start the radio server autodj by using command `./radioserver autodjon`

## Commands for Ubuntu/Debian
Install lib32stdc++6

`apt-get install lib32stdc++6`

Give 777 permission

`chmod -R 777 radioserver`

## Commands for CentOS
Install lib32stdc++6

`yum install lib32stdc++6`

Give 777 permission

`chmod -R 777 radioserver`
