const express = require('express'); 
const User = require('./pkg/user');
const { oauth_token, github_user, organization, webhook_proxy } = require('./pkg/config');
const SmeeClient = require('smee-client');
const bodyParser = require('body-parser');
const JobConf = require('./pkg/config-jobs');

var app = express();

jobconf = new JobConf();

user = new User({
    oauth_token: oauth_token,
    username: github_user,
    organization: organization
});

user.getAuthStatus();

async function runScript({script, repoName, ref, ocp_project} = {}){
    // script: list of commands
    env_clone = process.env;
    var env_clone = Object.create( process.env );
    env_clone.OCP_PROJECT = ocp_project;
    env_clone.HOME = '/var/tmp/' + repoName + '/' + ref;

    let complete_comm = "set -e;";
    for (let comm of script) {
        complete_comm += comm + ';'
    }

    return await user.runInRepo({ 
        repoName: repoName,
        command: complete_comm,
        ref: ref,
        env_vars: env_clone,
        timeout: 1800 
    });
}

async function execJob(chunkObj) {

    let refSanitized = chunkObj.ref.replace(/\//g, '-');

    // update local repo with remote changes
    user.registerRepo(chunkObj.repository.name);

    // kill any previous jobs running in this repo
    await user.killRepoJob(chunkObj.repository.name, refSanitized, () => {
        user.updateStatus({
            repoName: chunkObj.repository.name,
            ref: refSanitized,
            sha: chunkObj.after,
            status: ''
        })       
    });
    
    // sync new changes to local repo
    await user.syncRepo({
        repoName: chunkObj.repository.name,
        ref: refSanitized,
        tree_sha: chunkObj.head_commit.tree_id
    });

    // read in job config
    jobconf.clear();
    try{
        jobconf.read('/var/tmp/' + chunkObj.repository.name + '/' + refSanitized + '/ci.yml');
    } catch(err) {
        console.log(err);
        return
    }

    // post pending status
    user.updateStatus({
        repoName: chunkObj.repository.name,
        ref: refSanitized,
        sha: chunkObj.after,
        status: 'pending'
    }).then( (data) => {
        if(data.body.message) {
            console.log("[CI Server] Failed to update 'pending' statuses to " + chunkObj.repository.name + " with: " + body.message);
        } else {
            console.log("[CI Server] Posted status 'pending' to repo " + chunkObj.repository.name);
        }
    }).catch((err) => {
        console.log("Failed to update status: " + err);
    })

    //run scripts
    console.log("\n\nRunning Scripts");
    results = await runScript({
        script: jobconf.script, 
        repoName: chunkObj.repository.name,
        ref: refSanitized, 
        ocp_project: chunkObj.after
    })

    let end_status = "";
    if(results.code == 2) {
        await user.killRepoJob(chunkObj.repository.name, refSanitized);
        end_status = "failure";
    } else if(results.code != 0) {
        end_status = "failure";
    } else {
        end_status = "success";
    }             

    console.log('Script for ' + chunkObj.repository.name + ':' + chunkObj.after + ' ended with status ' + end_status)

   // run after_script 

    console.log("\n\nRunning After_Script");

    asResults = await runScript({
        script: jobconf.after_script, 
        repoName: chunkObj.repository.name,
        ref: refSanitized,
        ocp_project: chunkObj.after
    });

    if(asResults.code == 2) { //timeout
        await user.killRepoJob(chunkObj.repository.name, refSanitized);
    }

    user.postGist("******Script results******\n" + results.data + "\n\n******After Scripts******\n" + asResults.data, (error, url) => {
        if(error) {
            console.log('Could not post test output to gist: ');
            console.log(error);
        } else {
            console.log("Gist available at: " + url);
        }

        // post final script statuses
        user.updateStatus({
            repoName: chunkObj.repository.name,
            ref: refSanitized,
            sha: chunkObj.after,
            status: end_status,
            url: url
        }).then( (data) => {
            if(data.body.message) {
                console.log("[CI Server] Failed to update statuses: " + body.message);
            } else {
                console.log("[CI Server] Posted status '" + end_status + "' to repo " + chunkObj.repository.name);
            }
        }).catch((err) => {
            console.log("Failed to update status: " + err);
        })
    });
}

app.use(bodyParser.json());

app.post('/commit', (req) => {
    try{
        let event = req.headers['x-github-event'];
        switch(event) {
            case 'push':
                let chunk = req.body;
                if(chunk.after == "0000000000000000000000000000000000000000"){
                    return
                }
                execJob(chunk);
                break;
            case 'pull_request':
                console.log('Recieved PR event');
                break;
            default:
                console.log('Unrecognized github event: ' + event)
                break;
        }
    } catch(error) {
        console.log('While parshing incoming message: ' + error);
    }
});

var server = app.listen(3000, () => {
    console.log("Listening on port 3000 for github webhooks");
})

if(webhook_proxy){
    const smee = new SmeeClient({
    source: webhook_proxy,
    target: 'http://localhost:3000/commit',
    logger: console 
    })

    smee.start();
}